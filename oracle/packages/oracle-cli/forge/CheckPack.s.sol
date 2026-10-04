// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Script, console} from "forge-std/Script.sol";
import {Vm as VmLite} from "forge-std/Vm.sol";
import {stdJson} from "forge-std/StdJson.sol";
import {IMarketConfig} from "@eros/interfaces/IMarketConfig.sol";
import {Globals, Ledger, MarketInput, TrustSetInput} from "../../../src/types/OracleTypes.sol";
import {BondTreasury} from "../../../src/BondTreasury.sol";
import {MarketRegistry} from "../../../src/MarketRegistry.sol";
import {ResolutionOracle} from "../../../src/ResolutionOracle.sol";
import {BondMath} from "../../../src/libraries/BondMath.sol";
import {StubMarketFactory} from "../../../src/testnet/StubMarketFactory.sol";
import {TestUSDC} from "../../../src/testnet/TestUSDC.sol";
import {MockAssertionVenue} from "../../../test/mocks/MockAssertionVenue.sol";
import {CreateTrustSet} from "../../../script/CreateTrustSet.s.sol";
import {ListMarket} from "../../../script/ListMarket.s.sol";

/// ListMarket's own pack parser, so the check reads `pack.json` exactly as the listing script will.
contract PackReader is ListMarket {
    function read(string memory pack, address usdc)
        external
        view
        returns (MarketInput memory m, IMarketConfig.Listing memory l, bytes memory engineInit)
    {
        m = _marketInput(pack, usdc);
        l = _engineListing(pack, usdc);
        engineInit = stdJson.readBytes(pack, ".engineInit");
    }
}

/// CreateTrustSet's own reader of `params.globals` (globals version 1).
contract GlobalsReader is CreateTrustSet {
    function read(string memory params) external pure returns (Globals memory) {
        return _globals(params);
    }
}

/// @title CheckPack
/// @notice The Foundry dry-run of `oracle-cli list` (task O22.2): `createMarket` with the pack, sent by the lister
///         to a throwaway stack built in memory from `params.<network>.json` (its globals, providers and
///         authRefs), so every registry rule (§6.3 rules 1-6, then the treasury commitment, the factory handshake
///         and the store) is applied by the contracts themselves. Nothing is broadcast and no RPC is used.
/// @dev Environment: `PACK_JSON` (the pack's content), `PARAMS` (path, default the testnet params), `NOW` (unix
///      time of the listing, default the wall clock), `PROVIDERS` (comma-separated hosts added to
///      `params.providers`, which stay empty until X03/X04 choose them), `MIN_BOND` (the venue's minimum bond,
///      default 2,000,000 = 2 x DeployUmaSandbox's default final fee, as the UMA sandbox computes it). The
///      venue is a scripted double: rules 1-6 read only its `minimumBond` and `bondCurrency`.
contract CheckPack is Script {
    function run() external returns (bytes32 marketId, address engine) {
        string memory pack = vm.envString("PACK_JSON");
        string memory params = vm.readFile(vm.envOr("PARAMS", string("deployments/params.monad-testnet.json")));
        string[] memory extra = vm.envOr("PROVIDERS", ",", new string[](0));
        for (uint256 i; i < extra.length; ++i) {
            console.log("provider assumed (PROVIDERS):", extra[i]);
        }
        vm.warp(vm.envOr("NOW", vm.unixTime() / 1000));
        PackChecker checker = new PackChecker(new PackReader(), new GlobalsReader());
        uint256 bondAtCap;
        (marketId, engine, bondAtCap) = checker.check(pack, params, extra, vm.envOr("MIN_BOND", uint256(2_000_000)));
        console.log("== createMarket: ok, rules 1-6 pass; engine", engine);
        console.log("   bond at the OI cap", bondAtCap);
    }
}

/// Deploys the stack and lists the pack; it is the stack's governance and lister.
contract PackChecker {
    using stdJson for string;

    address internal constant GUARDIAN = address(0x6A);
    address internal constant FORWARDER = address(0xF0);
    address internal constant ATTESTOR = address(0xA7);
    address internal constant WATCHDOG = address(0xD0);
    VmLite internal constant vm = VmLite(address(uint160(uint256(keccak256("hevm cheat code")))));

    PackReader internal immutable reader;
    GlobalsReader internal immutable globalsReader;

    struct Stack {
        TestUSDC usdc;
        MockAssertionVenue venue;
        BondTreasury treasury;
        ResolutionOracle ro;
        MarketRegistry reg;
    }

    constructor(PackReader reader_, GlobalsReader globalsReader_) {
        reader = reader_;
        globalsReader = globalsReader_;
    }

    function check(string memory pack, string memory params, string[] memory extraProviders, uint256 minBond)
        external
        returns (bytes32 marketId, address engine, uint256 bondAtCap)
    {
        Stack memory s = _deploy(params, minBond);
        _govern(s, params, extraProviders);
        (MarketInput memory m, IMarketConfig.Listing memory l, bytes memory engineInit) =
            reader.read(pack, address(s.usdc));
        marketId = m.marketId;
        // Step 7 is the live treasury's job (ListMarket checks it); here ASSERTION holds exactly this bond.
        bondAtCap = BondMath.bond(m.oiCapLots, m.uma, s.venue.minimumBond());
        s.usdc.mint(address(this), bondAtCap);
        s.usdc.approve(address(s.treasury), bondAtCap);
        s.treasury.deposit(Ledger.ASSERTION, bondAtCap);
        engine = s.reg.createMarket(m, l, engineInit);
        require(s.reg.isListed(marketId), "not listed");
    }

    /// The stack comes from the build artifacts (`deployCode`), not `new`: nesting the creation code of every
    /// contract would put the script itself above the code size limit (forge 1.8.3 refuses it).
    function _deploy(string memory params, uint256 minBond) internal returns (Stack memory s) {
        s.usdc = TestUSDC(vm.deployCode("TestUSDC.sol:TestUSDC"));
        s.venue =
            MockAssertionVenue(vm.deployCode("MockAssertionVenue.sol:MockAssertionVenue", abi.encode(s.usdc, minBond)));
        uint256 n = vm.getNonce(address(this));
        address oracleAt = vm.computeCreateAddress(address(this), n + 1);
        address registryAt = vm.computeCreateAddress(address(this), n + 2);
        address factoryAt = vm.computeCreateAddress(address(this), n + 3);
        uint64 selector = uint64(vm.parseUint(params.readString(".creChainSelector")));
        address self = address(this);
        s.treasury = BondTreasury(
            vm.deployCode("BondTreasury.sol:BondTreasury", abi.encode(s.usdc, oracleAt, registryAt, self))
        );
        s.ro = ResolutionOracle(
            vm.deployCode(
                "ResolutionOracle.sol:ResolutionOracle",
                abi.encode(registryAt, s.treasury, s.usdc, selector, self, GUARDIAN)
            )
        );
        s.reg = MarketRegistry(
            vm.deployCode(
                "MarketRegistry.sol:MarketRegistry", abi.encode(oracleAt, s.treasury, factoryAt, s.usdc, self, self)
            )
        );
        address factory = vm.deployCode("StubMarketFactory.sol:StubMarketFactory", abi.encode(registryAt));
        require(address(s.ro) == oracleAt && address(s.reg) == registryAt && factory == factoryAt, "wiring");
    }

    /// Governance setup as CreateTrustSet and FundTreasury print it (sim trust set, globals v1, lists).
    function _govern(Stack memory s, string memory params, string[] memory extraProviders) internal {
        s.ro.createTrustSet(_trustSet(address(s.venue)));
        s.ro.activateTrustSet(1);
        s.reg.setGlobals(globalsReader.read(params));
        string[] memory providers = params.readStringArray(".providers");
        for (uint256 i; i < providers.length; ++i) {
            s.reg.setProvider(providers[i], true);
        }
        for (uint256 i; i < extraProviders.length; ++i) {
            s.reg.setProvider(extraProviders[i], true);
        }
        string[] memory refs = params.readStringArray(".authRefs");
        for (uint256 i; i < refs.length; ++i) {
            s.reg.setAuthRef(keccak256(bytes(refs[i])), true);
        }
        s.treasury.setLimits(params.readUint(".treasuryLimits.maxPerMarketAtoms"), 20);
    }

    function _trustSet(address venue) internal pure returns (TrustSetInput memory t) {
        t.forwarder = FORWARDER;
        t.runnerAttestor = ATTESTOR;
        t.committee = new address[](3);
        (t.committee[0], t.committee[1], t.committee[2]) = (address(0xC1), address(0xC2), address(0xC3));
        t.threshold = 2;
        t.watchdog = WATCHDOG;
        t.venue = venue;
    }
}
