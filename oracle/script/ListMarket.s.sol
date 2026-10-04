// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {console} from "forge-std/Script.sol";
import {stdJson} from "forge-std/StdJson.sol";
import {IMarketConfig} from "@eros/interfaces/IMarketConfig.sol";
import {MarginMath} from "@eros/math/MarginMath.sol";
import {GovernanceOp} from "./GovernanceOp.sol";
import {AIConfig, FeedSpec, Globals, Ledger, MarketInput, Outcome, UMAConfig} from "../src/types/OracleTypes.sol";
import {MarketRegistry} from "../src/MarketRegistry.sol";
import {BondTreasury} from "../src/BondTreasury.sol";
import {IAssertionVenue} from "../src/interfaces/IAssertionVenue.sol";
import {BondMath} from "../src/libraries/BondMath.sol";
import {ClaimRenderer} from "../src/libraries/ClaimRenderer.sol";
import {FeedSpecLib} from "../src/libraries/FeedSpecLib.sol";
import {HostLib} from "../src/libraries/HostLib.sol";

/// @title ListMarket
/// @notice Lists one market from its listing pack (plan §12.9; task O19.4). Reads `PACK` (`pack.json`: the
///         `createMarket` arguments, schema below), then checks what §12.9 asks before anyone signs:
///         step 6, the claim rendered for a YES with the longest evidence stands alone within
///         `maxClaimBytes`; step 7, the ASSERTION ledger covers every listing's commitment plus this market's
///         bond at its OI cap; step 8, `createMarket` succeeds when sent by the registry's lister, with the
///         Foundry gas of that call (Monad's MIP-8 storage pricing is not modelled: V-M3 is taken from the first
///         testnet listing, X04). Then it prints the lister's transaction: the Safe's own transaction on
///         testnet (lister = team Safe), a Timelock operation when the lister is the Timelock. Nothing is
///         broadcast.
/// @dev pack.json: `{ "marketInput": {...}, "engineListing": {...}, "engineInit": "0x..." }`. `marketInput`
///      has the `MarketInput` fields by name (`feed`, `ai`, `uma` nested; `uma.bondCurrency` is the
///      deployment's USDC and the SSTORE2 pointers are ignored, so neither is read); `engineListing` has the
///      engine's own `Listing` fields (`engineGovernance`, `template`, `deploymentCapX`, `maxTraders`,
///      `indexSourceId`, `indexSigner`, `indexRulesHash`, `depthNLots`, `maxSpreadWad`, `bootstrapBandWad`,
///      `minOrderLots`, `maxOrderLots`, `maxLiqLotsPerBlock`, `fundingEnabled`); the registry sets the seam
///      fields. `oracle-cli list` (O22) writes it to `listings/<marketId>/pack.json`; `listings/example/pack.json` is a
///      filled one.
///      `SHIFT_TO_NOW=true` moves windowStart to now and T and windowEnd with it (dry runs of a stored pack).
contract ListMarket is GovernanceOp {
    using stdJson for string;

    error ClaimTooLong(uint256 bytes_, uint256 max);
    error Underfunded(uint256 need, uint256 have);

    struct Stack {
        MarketRegistry reg;
        BondTreasury treasury;
        address venue;
        address usdc;
        address timelock;
    }

    function run() external returns (bytes32 marketId) {
        string memory deployments = _deployments();
        Stack memory s;
        s.reg = MarketRegistry(_contract(deployments, "MarketRegistry"));
        s.treasury = BondTreasury(_contract(deployments, "BondTreasury"));
        s.venue = _contract(deployments, "UmaAdapter");
        s.usdc = deployments.readAddress(".usdc");
        s.timelock = deployments.readAddress(".roles.timelock");
        string memory pack = vm.readFile(vm.envString("PACK"));

        MarketInput memory m = _marketInput(pack, s.usdc);
        IMarketConfig.Listing memory l = _engineListing(pack, s.usdc);
        bytes memory engineInit = pack.readBytes(".engineInit");
        marketId = m.marketId;

        _checkClaim(m, s.reg);
        _checkFunding(m, s);
        bytes memory data = abi.encodeCall(s.reg.createMarket, (m, l, engineInit));
        address lister = s.reg.lister();
        if (lister == s.timelock) {
            Call[] memory calls = new Call[](1);
            _push(calls, 0, address(s.reg), data);
            _propose(string.concat("list ", vm.toString(marketId)), calls, s.timelock);
            return marketId;
        }
        vm.prank(lister);
        uint256 g = gasleft();
        (bool ok, bytes memory ret) = address(s.reg).call(data);
        uint256 used = g - gasleft();
        if (!ok) revert CallFailed(0, ret);
        console.log("== createMarket simulated as the lister: ok; engine", abi.decode(ret, (address)));
        console.log("Foundry gas of createMarket (not Monad MIP-8 pricing; V-M3 from X04):", used);
        console.log("Lister transaction (the team Safe): to", address(s.reg));
        console.logBytes(data);
    }

    // ------------------------------------------------------------------ §12.9 checks

    /// Step 6: the claim for a YES with the longest evidence URI renders and fits `maxClaimBytes`.
    function _checkClaim(MarketInput memory m, MarketRegistry reg) internal view {
        Globals memory g = reg.globalsAt(reg.globalsVersion());
        ClaimRenderer.Fields memory f;
        f.marketId = m.marketId;
        f.chainId = block.chainid;
        f.oracle = reg.oracle();
        f.question = m.question;
        f.rules = m.rules;
        f.tau = m.tau;
        f.outcome = Outcome.YES;
        f.evidence = m.hasFeed
            ? ClaimRenderer.l1Evidence(
                bytes32(type(uint256).max), HostLib.substitute(m.feed.urlTemplate, m.feed.urlParam)
            )
            : string(new bytes(256));
        f.evidenceHash = keccak256("evidence");
        bytes memory claim = ClaimRenderer.render(m.claimTemplate, f);
        if (claim.length > g.maxClaimBytes) revert ClaimTooLong(claim.length, g.maxClaimBytes);
        console.log("== claim preview (YES, longest evidence):", claim.length, "bytes; max", g.maxClaimBytes);
        console.log(string(claim));
    }

    /// Step 7: ASSERTION covers every open listing commitment plus this market's bond at its OI cap.
    function _checkFunding(MarketInput memory m, Stack memory s) internal view {
        uint256 bondAtCap = BondMath.bond(m.oiCapLots, m.uma, IAssertionVenue(s.venue).minimumBond());
        uint256 need = s.treasury.totalCommitted() + bondAtCap;
        uint256 have = s.treasury.balanceOf(Ledger.ASSERTION);
        if (have < need) revert Underfunded(need, have);
        console.log("== funding: bond at the OI cap", bondAtCap, "ASSERTION after listing", have - need);
    }

    // ------------------------------------------------------------------ pack

    function _marketInput(string memory p, address usdc) internal view returns (MarketInput memory m) {
        m.marketId = p.readBytes32(".marketInput.marketId");
        m.question = p.readString(".marketInput.question");
        m.rules = p.readString(".marketInput.rules");
        m.claimTemplate = p.readString(".marketInput.claimTemplate");
        m.windowStart = uint64(p.readUint(".marketInput.windowStart"));
        m.windowEnd = uint64(p.readUint(".marketInput.windowEnd"));
        m.tau = uint64(p.readUint(".marketInput.tau"));
        if (vm.envOr("SHIFT_TO_NOW", false)) {
            // Keep the pack's durations, starting now (the stored times may be past or future).
            (uint64 window, uint64 toTau) = (m.windowEnd - m.windowStart, m.tau - m.windowStart);
            m.windowStart = uint64(block.timestamp);
            (m.windowEnd, m.tau) = (m.windowStart + window, m.windowStart + toTau);
        }
        m.groupId = p.readBytes32(".marketInput.groupId");
        m.groupExclusive = p.readBool(".marketInput.groupExclusive");
        m.hasFeed = p.readBool(".marketInput.hasFeed");
        m.feed = _feed(p);
        m.allowList = p.readStringArray(".marketInput.allowList");
        m.ai = _ai(p);
        m.uma = _uma(p, usdc);
        m.l2DeadlineSecs = uint32(p.readUint(".marketInput.l2DeadlineSecs"));
        m.voidSecs = uint32(p.readUint(".marketInput.voidSecs"));
        m.monitor = p.readAddress(".marketInput.monitor");
        m.oiCapLots = p.readUint(".marketInput.oiCapLots");
        m.dryRunHash = p.readBytes32(".marketInput.dryRunHash");
        m.ambiguityLogHash = p.readBytes32(".marketInput.ambiguityLogHash");
        console.log("== pack: market", vm.toString(m.marketId));
        console.log("   specHash", vm.toString(FeedSpecLib.specHash(m.feed)));
    }

    function _feed(string memory p) internal pure returns (FeedSpec memory f) {
        f.urlTemplate = p.readString(".marketInput.feed.urlTemplate");
        f.urlParam = p.readString(".marketInput.feed.urlParam");
        f.authRef = p.readBytes32(".marketInput.feed.authRef");
        f.finalPath = p.readString(".marketInput.feed.finalPath");
        f.finalValue = p.readString(".marketInput.feed.finalValue");
        f.valuePath = p.readString(".marketInput.feed.valuePath");
        f.valueType = uint8(p.readUint(".marketInput.feed.valueType"));
        f.decimals = uint8(p.readUint(".marketInput.feed.decimals"));
        f.op = uint8(p.readUint(".marketInput.feed.op"));
        f.target = p.readString(".marketInput.feed.target");
        f.bufferSecs = uint32(p.readUint(".marketInput.feed.bufferSecs"));
        f.l1TimeoutSecs = uint32(p.readUint(".marketInput.feed.l1TimeoutSecs"));
    }

    function _ai(string memory p) internal pure returns (AIConfig memory a) {
        bytes32[] memory models = p.readBytes32Array(".marketInput.ai.modelIdHashes");
        a.modelIdHashes = [models[0], models[1], models[2]];
        a.promptHash = p.readBytes32(".marketInput.ai.promptHash");
        a.calibratorHash = p.readBytes32(".marketInput.ai.calibratorHash");
        a.categoryId = p.readBytes32(".marketInput.ai.categoryId");
        a.highConfBps = uint16(p.readUint(".marketInput.ai.highConfBps"));
    }

    function _uma(string memory p, address usdc) internal pure returns (UMAConfig memory u) {
        u.bondCurrency = usdc;
        u.minBond = p.readUint(".marketInput.uma.minBond");
        u.bondBps = uint16(p.readUint(".marketInput.uma.bondBps"));
        u.livenessL1 = uint64(p.readUint(".marketInput.uma.livenessL1"));
        u.livenessAuto = uint64(p.readUint(".marketInput.uma.livenessAuto"));
        u.livenessReviewed = uint64(p.readUint(".marketInput.uma.livenessReviewed"));
    }

    function _engineListing(string memory p, address usdc) internal pure returns (IMarketConfig.Listing memory l) {
        l.token = usdc;
        l.governance = p.readAddress(".engineListing.engineGovernance");
        l.template = MarginMath.Template(uint8(p.readUint(".engineListing.template")));
        l.deploymentCapX = p.readUint(".engineListing.deploymentCapX");
        l.maxTraders = uint32(p.readUint(".engineListing.maxTraders"));
        l.indexSourceId = p.readBytes32(".engineListing.indexSourceId");
        l.indexSigner = p.readAddress(".engineListing.indexSigner");
        l.indexRulesHash = p.readBytes32(".engineListing.indexRulesHash");
        l.depthNLots = p.readUint(".engineListing.depthNLots");
        l.maxSpreadWad = p.readUint(".engineListing.maxSpreadWad");
        l.bootstrapBandWad = p.readUint(".engineListing.bootstrapBandWad");
        l.minOrderLots = uint64(p.readUint(".engineListing.minOrderLots"));
        l.maxOrderLots = uint64(p.readUint(".engineListing.maxOrderLots"));
        l.maxLiqLotsPerBlock = uint64(p.readUint(".engineListing.maxLiqLotsPerBlock"));
        l.fundingEnabled = p.readBool(".engineListing.fundingEnabled");
    }
}
