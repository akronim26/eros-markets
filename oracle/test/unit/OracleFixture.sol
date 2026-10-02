// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {MockUSDC} from "@eros-test/mocks/A/MockUSDC.sol";
import {IMarketConfig} from "@eros/interfaces/IMarketConfig.sol";
import {Ledger, MarketInput, Resolution, RState, TrustSetInput} from "../../src/types/OracleTypes.sol";
import {MarketRegistry} from "../../src/MarketRegistry.sol";
import {BondTreasury} from "../../src/BondTreasury.sol";
import {RegistryFixture} from "./RegistryFixture.sol";
import {ResolutionOracleHarness} from "../mocks/ResolutionOracleHarness.sol";
import {MockAssertionVenue} from "../mocks/MockAssertionVenue.sol";
import {MockMarketFactory} from "../mocks/MockMarketFactory.sol";
import {MockResolutionEngine} from "../mocks/MockResolutionEngine.sol";

/// @notice Shared fixture for the ResolutionOracle tests (tasks O14.2-O14.6): the real MarketRegistry,
///         BondTreasury and ResolutionOracle (harness) wired through precomputed addresses as the deploy
///         script does (§12.5), `MockMarketFactory` engines (`MockResolutionEngine` knobs), a token-moving
///         `MockAssertionVenue`, and one active trust set with real committee and attestor keys.
/// @dev Values are the plan's testnet demo (§12.11 globals, §14.1): T 30 minutes after listing, buffer
///      60 s, L1 timeout 300 s, L2 deadline 600 s, liveness 120/120/300 s, voidSecs 2 h, OI 100,000 lots,
///      so the bond is max(2, 11.12) USDC = 11,120,000 atoms (§12.5). The `oracle` mock of the
///      RegistryFixture is unused here.
abstract contract OracleFixture is RegistryFixture {
    uint64 internal constant SELECTOR = 2183018362218727504; // Monad testnet
    uint64 internal constant T = NOW + 1_800;
    uint256 internal constant OI = 100_000;
    uint256 internal constant BOND = 11_120_000;

    MockUSDC internal token;
    MockMarketFactory internal factory;
    MockAssertionVenue internal mvenue;
    BondTreasury internal treasury;
    ResolutionOracleHarness internal ro;
    MarketRegistry internal reg;

    address internal guardian = makeAddr("guardian");
    address internal lister = makeAddr("lister");
    address internal watchdog = makeAddr("watchdog");
    address internal monitor = address(0x30); // RegistryFixture._market().monitor
    address internal keeper = makeAddr("keeper");
    address internal mockForwarder = makeAddr("mock forwarder");
    address internal attestor;
    uint256 internal attestorKey;
    address[] internal members; // strictly ascending
    uint256[] internal memberKeys; // same order

    function setUp() public virtual {
        vm.chainId(10143);
        vm.warp(NOW);
        token = new MockUSDC();
        usdc = address(token);
        factory = new MockMarketFactory();
        mvenue = new MockAssertionVenue(usdc, 2e6);
        address me = address(this);
        uint256 n = vm.getNonce(me);
        address treasuryAddr = vm.computeCreateAddress(me, n);
        address oracleAddr = vm.computeCreateAddress(me, n + 1);
        address registryAddr = vm.computeCreateAddress(me, n + 2);
        treasury = new BondTreasury(usdc, oracleAddr, registryAddr, gov);
        ro = new ResolutionOracleHarness(registryAddr, treasuryAddr, usdc, SELECTOR, gov, guardian);
        reg = new MarketRegistry(oracleAddr, treasuryAddr, address(factory), usdc, gov, lister);
        require(address(treasury) == treasuryAddr && address(ro) == oracleAddr && address(reg) == registryAddr);

        (attestor, attestorKey) = makeAddrAndKey("attestor");
        _makeCommittee();
        vm.startPrank(gov);
        ro.createTrustSet(_trustSet());
        ro.activateTrustSet(1);
        reg.setGlobals(_globals());
        reg.setProvider(HOST, true);
        reg.setProvider(OTHER, true);
        treasury.setLimits(100e6, 20);
        vm.stopPrank();

        token.mint(me, 10_000e6);
        token.approve(address(treasury), type(uint256).max);
        treasury.deposit(Ledger.ASSERTION, 1_000e6);
        treasury.deposit(Ledger.WATCHDOG_FLOAT, 100e6);
    }

    // ------------------------------------------------------------------ fixtures

    function _makeCommittee() internal {
        string[3] memory names = ["member-a", "member-b", "member-c"];
        for (uint256 i; i < 3; ++i) {
            (address a, uint256 k) = makeAddrAndKey(names[i]);
            members.push(a);
            memberKeys.push(k);
        }
        for (uint256 i; i < 3; ++i) {
            for (uint256 j = i + 1; j < 3; ++j) {
                if (members[j] < members[i]) {
                    (members[i], members[j]) = (members[j], members[i]);
                    (memberKeys[i], memberKeys[j]) = (memberKeys[j], memberKeys[i]);
                }
            }
        }
    }

    function _trustSet() internal view returns (TrustSetInput memory t) {
        t.forwarder = mockForwarder;
        t.runnerAttestor = attestor;
        t.committee = members;
        t.threshold = 2;
        t.watchdog = watchdog;
        t.venue = address(mvenue);
    }

    /// Engine fields from the listing pack (the registry overwrites the seam fields).
    function _pack() internal view returns (IMarketConfig.Listing memory l) {
        l.token = usdc;
        l.governance = gov;
        l.indexSigner = address(0x51);
        l.deploymentCapX = 1;
        l.maxTraders = 1024;
        l.depthNLots = 500;
        l.minOrderLots = 1;
        l.maxOrderLots = 1e9;
    }

    /// Lists `m` through the real registry; the engine reports `OI` lots at its halt.
    function _list(MarketInput memory m) internal returns (MockResolutionEngine engine) {
        IMarketConfig.Listing memory l = _pack();
        vm.prank(lister);
        engine = MockResolutionEngine(reg.createMarket(m, l, abi.encode(OI)));
    }

    /// The fixture's Layer 1 market (`_market()`), listed.
    function _listFeed() internal returns (bytes32 id, MockResolutionEngine engine) {
        MarketInput memory m = _market();
        id = m.marketId;
        engine = _list(m);
    }

    /// The same market without a feed, listed under another id.
    function _listNoFeed() internal returns (bytes32 id, MockResolutionEngine engine) {
        MarketInput memory m = _noFeed();
        m.marketId = keccak256("market-no-feed");
        id = m.marketId;
        engine = _list(m);
    }

    function _res(bytes32 id) internal view returns (Resolution memory) {
        return ro.getResolution(id);
    }

    function _state(bytes32 id) internal view returns (RState) {
        return ro.getResolution(id).state;
    }

    /// Overwrites one market's state through the harness, keeping every other field.
    function _forceState(bytes32 id, RState s) internal {
        Resolution memory r = ro.getResolution(id);
        r.state = s;
        ro.setResolution(id, r);
    }
}
