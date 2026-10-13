// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Script, console2} from "forge-std/Script.sol";
import {stdJson} from "forge-std/StdJson.sol";
import {IMarketConfig} from "@eros/interfaces/IMarketConfig.sol";
import {NativeOutcomeVault} from "@eros/native/NativeOutcomeVault.sol";
import {FeedSpec, MarketCore, MarketInput} from "../../src/types/OracleTypes.sol";
import {MarketRegistry} from "../../src/MarketRegistry.sol";
import {SpotResolutionAnchor} from "../../src/native/SpotResolutionAnchor.sol";

/// @title ListNativeSpotMarket (NM-S04)
/// @notice Lists a native spot prediction market: the registry (pointed at the `SpotMarketFactory` by
///         `SpotMarketGovernance OP=enable`) deploys a `SpotResolutionAnchor` instead of a perp engine,
///         the market carries the canonical API-Sports Layer-1 feed (`e2e/src/native-spot-feed.ts`), and
///         the outcome vault from `DeployNativeMarket` binds to the anchor. No perp, INDEX source, signer,
///         keeper or funding exists for this market.
///
///         Oracle configuration with no spot-specific value (AI panel, UMA bond/liveness, L2 deadline,
///         claim template) is copied from an already-listed `templateMarketId`, so no trust or
///         calibration input is invented. Lister only.
///
///   NATIVE_DEPLOYMENT=deployments/native/<m>.json SPOT_LISTING=listings/native/<m>/listing.json \
///   forge script script/native/ListNativeSpotMarket.s.sol --rpc-url $RPC --broadcast --private-key $LISTER_KEY
contract ListNativeSpotMarket is Script {
    using stdJson for string;

    function run() external returns (address anchor) {
        string memory d = vm.readFile(vm.envString("NATIVE_DEPLOYMENT"));
        string memory p = vm.readFile(vm.envString("SPOT_LISTING"));
        MarketRegistry reg = MarketRegistry(d.readAddress(".registry"));
        NativeOutcomeVault vault = NativeOutcomeVault(d.readAddress(".outcomeVault"));
        string memory rules = p.readString(".rules");
        require(keccak256(bytes(rules)) == d.readBytes32(".erosRulesHash"), "RULES_TEXT_HASH_MISMATCH");
        require(vault.rulesHash() == d.readBytes32(".erosRulesHash") && vault.marketId() == d.readBytes32(".marketId"),
            "VAULT_DEPLOYMENT_MISMATCH");

        MarketInput memory m = marketInput(reg, d, p, rules);
        IMarketConfig.Listing memory l;
        l.token = d.readAddress(".collateral");

        vm.startBroadcast();
        anchor = reg.createMarket(m, l, "");
        vault.bindMarket();
        vm.stopBroadcast();
        require(vault.engine() == anchor, "BIND_FAILED");
        require(SpotResolutionAnchor(anchor).INVALID_PRICE_WAD() == 5e17, "NOT_A_SPOT_ANCHOR");
        console2.log("spot anchor", anchor);
        console2.log("vault bound", address(vault));
    }

    function marketInput(MarketRegistry reg, string memory d, string memory p, string memory rules)
        public
        view
        returns (MarketInput memory m)
    {
        bytes32 tmpl = p.readBytes32(".templateMarketId");
        MarketCore memory core = reg.getMarketCore(tmpl);
        require(core.engine != address(0), "TEMPLATE_NOT_LISTED");
        string memory f = vm.readFile(p.readString(".feed"));
        m.marketId = d.readBytes32(".marketId");
        m.question = p.readString(".question");
        m.rules = rules;
        m.claimTemplate = vm.readFile("listings/example/pack.json").readString(".marketInput.claimTemplate");
        m.windowStart = uint64(block.timestamp);
        m.tau = uint64(d.readUint(".scheduledT"));
        m.windowEnd = m.tau;
        m.hasFeed = true;
        m.feed = readFeed(f);
        require(keccak256(abi.encode(m.feed)) == f.readBytes32(".specHash"), "FEED_SPEC_HASH_MISMATCH");
        m.allowList = p.readStringArray(".evidenceHosts");
        m.ai = reg.getAIConfig(tmpl);
        m.uma = reg.getUMAConfig(tmpl);
        m.l2DeadlineSecs = core.l2DeadlineSecs;
        m.voidSecs = uint32(p.readUint(".voidSecs"));
        m.monitor = core.monitor;
        m.oiCapLots = p.readUint(".oiCapLots");
        m.dryRunHash = keccak256(bytes(string.concat("native-spot-listing:", rules)));
        m.ambiguityLogHash =
            keccak256("Native Eros spot market: API-Sports Layer-1 feed; review route fallback; INVALID pays 0.5.");
    }

    function readFeed(string memory f) public pure returns (FeedSpec memory s) {
        s.urlTemplate = f.readString(".feed.urlTemplate");
        s.urlParam = f.readString(".feed.urlParam");
        s.authRef = f.readBytes32(".feed.authRef");
        s.finalPath = f.readString(".feed.finalPath");
        s.finalValue = f.readString(".feed.finalValue");
        s.valuePath = f.readString(".feed.valuePath");
        s.valueType = uint8(f.readUint(".feed.valueType"));
        s.decimals = uint8(f.readUint(".feed.decimals"));
        s.op = uint8(f.readUint(".feed.op"));
        s.target = f.readString(".feed.target");
        s.bufferSecs = uint32(f.readUint(".feed.bufferSecs"));
        s.l1TimeoutSecs = uint32(f.readUint(".feed.l1TimeoutSecs"));
    }
}
