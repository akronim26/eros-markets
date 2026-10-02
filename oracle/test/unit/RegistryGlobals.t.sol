// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {Globals, Category} from "../../src/types/OracleTypes.sol";
import {IMarketRegistry} from "../../src/interfaces/IMarketRegistry.sol";
import {MarketRegistry} from "../../src/MarketRegistry.sol";

/// @dev Exposes the registry's SSTORE2 text helpers.
contract RegistryTextHarness is MarketRegistry {
    constructor() MarketRegistry(address(1), address(2), address(0), address(3), address(4), address(5)) {}

    function writeText(string memory s) external returns (address) {
        return _writeText(s);
    }

    function readText(address p) external view returns (string memory) {
        return _readText(p);
    }
}

/// @notice Task O11.2: constructor, versioned globals with every plan §14.4 bound (BadGlobals codes per
///         ADJ-30), governance setters and their access control, SSTORE2 text helpers.
/// @dev Expected values come from the plan: the base globals are the §12.11 "Globals version 1"
///      testnet and mainnet columns; each bound is the §14.4 number, tested on both sides.
contract RegistryGlobalsTest is Test {
    uint256 internal constant TESTNET = 10143;
    uint256 internal constant MAINNET = 143;

    address internal oracle = makeAddr("oracle");
    address internal treasury = makeAddr("treasury");
    address internal factory = makeAddr("factory");
    address internal usdc = makeAddr("usdc");
    address internal gov = makeAddr("timelock");
    address internal lister = makeAddr("lister");
    address internal stranger = makeAddr("stranger");

    MarketRegistry internal reg;

    function setUp() public {
        vm.chainId(TESTNET);
        vm.warp(1_800_000_000);
        reg = new MarketRegistry(oracle, treasury, factory, usdc, gov, lister);
    }

    // ------------------------------------------------------------------ base globals (plan §12.11)

    function _testnet() internal pure returns (Globals memory g) {
        g.minHorizonSecs = 600;
        g.maxListingHorizon = 2_588_400;
        g.maxVoidSecs = 604_800;
        g.l2MinSecs = 60;
        g.l2MaxSecs = 3_600;
        g.bufferMinSecs = 60;
        g.bufferMaxSecs = 600;
        g.l1TimeoutMinSecs = 120;
        g.l1TimeoutMaxSecs = 3_600;
        g.tMinSecs = 60;
        g.bondBpsFloor = 1_112;
        g.highConfFloorBps = 5_000;
        g.maxClaimBytes = 16_384;
        g.dvmRoundSecs = 300;
        g.dvmMaxRolls = 0;
        g.reviewTargetSecs = 600;
        g.voidSlackSecs = 600;
        g.retryWindowSecs = 300;
        g.earlyTtlSecs = 600;
        g.minRequestIntervalSecs = 60;
        g.heartbeatMaxAgeSecs = 900;
        g.deltaPmaxBps = 200;
        g.nMin = 150;
        g.reviewLimitAtoms = 1_668_000_000;
        g.proposerRewardAtoms = 0;
    }

    function _mainnet() internal pure returns (Globals memory g) {
        g.minHorizonSecs = 86_400;
        g.maxListingHorizon = 2_588_400;
        g.maxVoidSecs = 5_184_000;
        g.l2MinSecs = 3_600;
        g.l2MaxSecs = 259_200;
        g.bufferMinSecs = 60;
        g.bufferMaxSecs = 21_600;
        g.l1TimeoutMinSecs = 3_600;
        g.l1TimeoutMaxSecs = 86_400;
        g.tMinSecs = 7_200;
        g.bondBpsFloor = 1_112;
        g.highConfFloorBps = 9_000;
        g.maxClaimBytes = 16_384;
        g.dvmRoundSecs = 172_800;
        g.dvmMaxRolls = 4;
        g.reviewTargetSecs = 7_200;
        g.voidSlackSecs = 172_800;
        g.retryWindowSecs = 86_400;
        g.earlyTtlSecs = 21_600;
        g.minRequestIntervalSecs = 240;
        g.heartbeatMaxAgeSecs = 900;
        g.deltaPmaxBps = 200;
        g.nMin = 150;
        g.reviewLimitAtoms = 1_668_000_000;
        g.proposerRewardAtoms = 5_000_000;
    }

    /// Sets `g` on `chainId` and expects code `code` (0 = accepted).
    function _check(uint256 chainId, Globals memory g, uint8 code) internal {
        vm.chainId(chainId);
        vm.prank(gov);
        if (code != 0) vm.expectRevert(abi.encodeWithSelector(IMarketRegistry.BadGlobals.selector, code));
        reg.setGlobals(g);
    }

    function _ok(uint256 chainId, Globals memory g) internal {
        _check(chainId, g, 0);
    }

    // ------------------------------------------------------------------ constructor

    function test_constructor() public view {
        assertEq(reg.oracle(), oracle);
        assertEq(reg.treasury(), treasury);
        assertEq(reg.factory(), factory);
        assertEq(reg.usdc(), usdc);
        assertEq(reg.governance(), gov);
        assertEq(reg.lister(), lister);
        assertEq(reg.globalsVersion(), 0);
    }

    function test_constructor_factoryMayBeZero() public {
        MarketRegistry r = new MarketRegistry(oracle, treasury, address(0), usdc, gov, lister);
        assertEq(r.factory(), address(0));
    }

    // ------------------------------------------------------------------ both base columns pass

    function test_baseColumnsPass() public {
        _ok(TESTNET, _testnet());
        _ok(TESTNET, _mainnet()); // production values sit inside the "any chain" column too
        _ok(MAINNET, _mainnet());
    }

    function test_testnetColumnRefusedOnMainnet() public {
        _check(MAINNET, _testnet(), 1); // the first failing rule is the horizon
    }

    // ------------------------------------------------------------------ code 1: listing horizon

    function test_bound1_minHorizon_anyChain() public {
        Globals memory g = _testnet();
        g.minHorizonSecs = 60;
        _ok(TESTNET, g);
        g.minHorizonSecs = 59;
        _check(TESTNET, g, 1);
    }

    function test_bound1_minHorizon_mainnet() public {
        Globals memory g = _mainnet();
        g.minHorizonSecs = 86_400;
        _ok(MAINNET, g);
        g.minHorizonSecs = 86_399;
        _check(MAINNET, g, 1);
    }

    function test_bound1_minNotAboveMax() public {
        Globals memory g = _testnet();
        g.minHorizonSecs = 3_600;
        g.maxListingHorizon = 3_600;
        _ok(TESTNET, g);
        g.minHorizonSecs = 3_601;
        _check(TESTNET, g, 1);
    }

    function test_bound1_maxListingHorizon() public {
        Globals memory g = _mainnet();
        g.maxListingHorizon = 2_588_400;
        _ok(MAINNET, g);
        g.maxListingHorizon = 2_588_401;
        _check(MAINNET, g, 1);
        _check(TESTNET, g, 1);
    }

    // ------------------------------------------------------------------ codes 2-4: min/max pairs

    function test_bound2_l2_anyChain() public {
        Globals memory g = _testnet();
        g.l2MinSecs = 60;
        _ok(TESTNET, g);
        g.l2MinSecs = 59;
        _check(TESTNET, g, 2);
        g.l2MinSecs = 3_600; // == l2MaxSecs
        _ok(TESTNET, g);
        g.l2MinSecs = 3_601;
        _check(TESTNET, g, 2);
    }

    function test_bound2_l2_mainnet() public {
        Globals memory g = _mainnet();
        g.l2MinSecs = 3_600;
        _ok(MAINNET, g);
        g.l2MinSecs = 3_599;
        _check(MAINNET, g, 2);
        _ok(TESTNET, g);
    }

    function test_bound3_buffer() public {
        Globals memory g = _testnet();
        g.bufferMinSecs = 60;
        _ok(TESTNET, g);
        g.bufferMinSecs = 59;
        _check(TESTNET, g, 3);
        _check(MAINNET, _withBufferMin(_mainnet(), 59), 3);
        g.bufferMinSecs = 600; // == bufferMaxSecs
        _ok(TESTNET, g);
        g.bufferMinSecs = 601;
        _check(TESTNET, g, 3);
    }

    function test_bound4_l1Timeout() public {
        Globals memory g = _testnet();
        g.l1TimeoutMinSecs = 60;
        _ok(TESTNET, g);
        g.l1TimeoutMinSecs = 59;
        _check(TESTNET, g, 4);
        g.l1TimeoutMinSecs = 3_600; // == l1TimeoutMaxSecs
        _ok(TESTNET, g);
        g.l1TimeoutMinSecs = 3_601;
        _check(TESTNET, g, 4);
        Globals memory m = _mainnet();
        m.l1TimeoutMinSecs = 59;
        _check(MAINNET, m, 4);
    }

    // ------------------------------------------------------------------ code 5: maxVoidSecs

    function test_bound5_maxVoidSecs() public {
        Globals memory g = _mainnet();
        g.maxVoidSecs = 90 days;
        _ok(MAINNET, g);
        _ok(TESTNET, g);
        g.maxVoidSecs = 90 days + 1;
        _check(MAINNET, g, 5);
        _check(TESTNET, g, 5);
    }

    // ------------------------------------------------------------------ code 6: tMinSecs

    function test_bound6_tMin_anyChain() public {
        Globals memory g = _testnet();
        g.tMinSecs = 60;
        _ok(TESTNET, g);
        g.tMinSecs = 59;
        _check(TESTNET, g, 6);
    }

    function test_bound6_tMin_mainnet() public {
        Globals memory g = _mainnet();
        g.tMinSecs = 7_200;
        _ok(MAINNET, g);
        g.tMinSecs = 7_199;
        _check(MAINNET, g, 6);
        _ok(TESTNET, g);
    }

    // ------------------------------------------------------------------ code 7: bondBpsFloor

    function test_bound7_bondBpsFloor_anyChain() public {
        Globals memory g = _testnet();
        g.bondBpsFloor = 1;
        _ok(TESTNET, g);
        g.bondBpsFloor = 0;
        _check(TESTNET, g, 7);
    }

    function test_bound7_bondBpsFloor_mainnet() public {
        Globals memory g = _mainnet();
        g.bondBpsFloor = 1_112;
        _ok(MAINNET, g);
        g.bondBpsFloor = 1_111;
        _check(MAINNET, g, 7);
        _ok(TESTNET, g);
    }

    // ------------------------------------------------------------------ code 8: highConfFloorBps

    function test_bound8_highConfFloor_anyChain() public {
        Globals memory g = _testnet();
        g.highConfFloorBps = 5_000;
        _ok(TESTNET, g);
        g.highConfFloorBps = 4_999;
        _check(TESTNET, g, 8);
    }

    function test_bound8_highConfFloor_mainnet() public {
        Globals memory g = _mainnet();
        g.highConfFloorBps = 9_000;
        _ok(MAINNET, g);
        g.highConfFloorBps = 8_999;
        _check(MAINNET, g, 8);
        _ok(TESTNET, g);
    }

    // ------------------------------------------------------------------ code 9: maxClaimBytes

    function test_bound9_maxClaimBytes() public {
        Globals memory g = _mainnet();
        g.maxClaimBytes = 32_768;
        _ok(MAINNET, g);
        _ok(TESTNET, g);
        g.maxClaimBytes = 32_769;
        _check(MAINNET, g, 9);
        _check(TESTNET, g, 9);
    }

    // ------------------------------------------------------------------ code 10: DVM round and rolls

    function test_bound10_dvm_anyChainUnbounded() public {
        Globals memory g = _testnet();
        g.dvmRoundSecs = 0;
        g.dvmMaxRolls = 0;
        _ok(TESTNET, g);
    }

    function test_bound10_dvm_mainnet() public {
        Globals memory g = _mainnet();
        g.dvmRoundSecs = 172_800;
        g.dvmMaxRolls = 4;
        _ok(MAINNET, g);
        g.dvmRoundSecs = 172_799;
        _check(MAINNET, g, 10);
        g.dvmRoundSecs = 172_800;
        g.dvmMaxRolls = 3;
        _check(MAINNET, g, 10);
    }

    // ------------------------------------------------------------------ code 11: review target and void slack

    function test_bound11_reviewAndSlack_anyChainUnbounded() public {
        Globals memory g = _testnet();
        g.reviewTargetSecs = 0;
        g.voidSlackSecs = 0;
        _ok(TESTNET, g);
    }

    function test_bound11_reviewAndSlack_mainnet() public {
        Globals memory g = _mainnet();
        g.reviewTargetSecs = 7_200;
        g.voidSlackSecs = 172_800;
        _ok(MAINNET, g);
        g.reviewTargetSecs = 7_199;
        _check(MAINNET, g, 11);
        g.reviewTargetSecs = 7_200;
        g.voidSlackSecs = 172_799;
        _check(MAINNET, g, 11);
    }

    // ------------------------------------------------------------------ code 12: retryWindowSecs

    function test_bound12_retryWindow_anyChain() public {
        Globals memory g = _testnet();
        g.retryWindowSecs = 60;
        _ok(TESTNET, g);
        g.retryWindowSecs = 59;
        _check(TESTNET, g, 12);
    }

    function test_bound12_retryWindow_mainnet() public {
        Globals memory g = _mainnet();
        g.retryWindowSecs = 3_600;
        _ok(MAINNET, g);
        g.retryWindowSecs = 3_599;
        _check(MAINNET, g, 12);
        _ok(TESTNET, g);
    }

    // ------------------------------------------------------------------ code 13: earlyTtlSecs

    function test_bound13_earlyTtl_anyChain() public {
        Globals memory g = _testnet();
        g.earlyTtlSecs = 60;
        _ok(TESTNET, g);
        g.earlyTtlSecs = 59;
        _check(TESTNET, g, 13);
        g.earlyTtlSecs = 86_400;
        _ok(TESTNET, g);
        g.earlyTtlSecs = 86_401;
        _check(TESTNET, g, 13);
    }

    function test_bound13_earlyTtl_mainnet() public {
        Globals memory g = _mainnet();
        g.earlyTtlSecs = 3_600;
        _ok(MAINNET, g);
        g.earlyTtlSecs = 3_599;
        _check(MAINNET, g, 13);
        _ok(TESTNET, g);
        g.earlyTtlSecs = 86_401;
        _check(MAINNET, g, 13);
    }

    // ------------------------------------------------------------------ code 14: minRequestIntervalSecs

    function test_bound14_minRequestInterval() public {
        Globals memory g = _testnet();
        g.minRequestIntervalSecs = 60;
        _ok(TESTNET, g);
        g.minRequestIntervalSecs = 59;
        _check(TESTNET, g, 14);
        g.minRequestIntervalSecs = 3_600;
        _ok(TESTNET, g);
        g.minRequestIntervalSecs = 3_601;
        _check(TESTNET, g, 14);
        Globals memory m = _mainnet();
        m.minRequestIntervalSecs = 3_601;
        _check(MAINNET, m, 14);
    }

    // ------------------------------------------------------------------ code 15: heartbeatMaxAgeSecs

    function test_bound15_heartbeatMaxAge() public {
        Globals memory g = _testnet();
        g.heartbeatMaxAgeSecs = 300;
        _ok(TESTNET, g);
        g.heartbeatMaxAgeSecs = 299;
        _check(TESTNET, g, 15);
        g.heartbeatMaxAgeSecs = 3_600;
        _ok(TESTNET, g);
        g.heartbeatMaxAgeSecs = 3_601;
        _check(TESTNET, g, 15);
        Globals memory m = _mainnet();
        m.heartbeatMaxAgeSecs = 299;
        _check(MAINNET, m, 15);
    }

    // ------------------------------------------------------------------ code 16: deltaPmaxBps and nMin

    function test_bound16_deltaPmax() public {
        Globals memory g = _testnet();
        g.deltaPmaxBps = 200;
        _ok(TESTNET, g);
        g.deltaPmaxBps = 201;
        _check(TESTNET, g, 16);
        Globals memory m = _mainnet();
        m.deltaPmaxBps = 201;
        _check(MAINNET, m, 16);
    }

    function test_bound16_nMin_anyChain() public {
        Globals memory g = _testnet();
        g.nMin = 1;
        _ok(TESTNET, g);
        g.nMin = 0;
        _check(TESTNET, g, 16);
    }

    function test_bound16_nMin_mainnet() public {
        Globals memory g = _mainnet();
        g.nMin = 150;
        _ok(MAINNET, g);
        g.nMin = 149;
        _check(MAINNET, g, 16);
        _ok(TESTNET, g);
    }

    // ------------------------------------------------------------------ code 17: proposerRewardAtoms

    function test_bound17_proposerReward() public {
        Globals memory g = _mainnet();
        g.proposerRewardAtoms = 1_000_000_000; // 1,000 USDC
        _ok(MAINNET, g);
        _ok(TESTNET, g);
        g.proposerRewardAtoms = 1_000_000_001;
        _check(MAINNET, g, 17);
        _check(TESTNET, g, 17);
    }

    // ------------------------------------------------------------------ reviewLimitAtoms: no onchain bound

    function test_reviewLimitAtoms_unbounded() public {
        Globals memory g = _mainnet();
        g.reviewLimitAtoms = 0;
        _ok(MAINNET, g);
        g.reviewLimitAtoms = type(uint256).max;
        _ok(MAINNET, g);
    }

    function test_firstFailingCodeWins() public {
        Globals memory g = _testnet();
        g.proposerRewardAtoms = 1_000_000_001; // code 17
        g.tMinSecs = 59; // code 6
        _check(TESTNET, g, 6);
    }

    // ------------------------------------------------------------------ versions

    function test_noGlobalsBeforeFirstSet() public {
        vm.expectRevert(abi.encodeWithSelector(IMarketRegistry.BadGlobals.selector, uint8(0)));
        reg.globals();
        vm.expectRevert(abi.encodeWithSelector(IMarketRegistry.BadGlobals.selector, uint8(0)));
        reg.globalsAt(0);
    }

    function test_versionsAppendAndOldOnesStayReadable() public {
        Globals memory g1 = _testnet();
        Globals memory g2 = _testnet();
        g2.minHorizonSecs = 86_400;
        g2.proposerRewardAtoms = 7;

        vm.expectEmit(address(reg));
        emit IMarketRegistry.GlobalsSet(1, keccak256(abi.encode(g1)));
        _ok(TESTNET, g1);
        assertEq(reg.globalsVersion(), 1);
        assertEq(keccak256(abi.encode(reg.globals())), keccak256(abi.encode(g1)));

        vm.expectEmit(address(reg));
        emit IMarketRegistry.GlobalsSet(2, keccak256(abi.encode(g2)));
        _ok(TESTNET, g2);
        assertEq(reg.globalsVersion(), 2);
        assertEq(keccak256(abi.encode(reg.globals())), keccak256(abi.encode(g2)));
        assertEq(keccak256(abi.encode(reg.globalsAt(1))), keccak256(abi.encode(g1)), "version 1 unchanged");
        assertEq(keccak256(abi.encode(reg.globalsAt(2))), keccak256(abi.encode(g2)));

        vm.expectRevert(abi.encodeWithSelector(IMarketRegistry.BadGlobals.selector, uint8(0)));
        reg.globalsAt(3);
    }

    function test_rejectedGlobalsDoNotAddAVersion() public {
        _ok(TESTNET, _testnet());
        Globals memory bad = _testnet();
        bad.maxClaimBytes = 32_769;
        _check(TESTNET, bad, 9);
        assertEq(reg.globalsVersion(), 1);
        assertEq(reg.globals().maxClaimBytes, 16_384);
    }

    // ------------------------------------------------------------------ governance setters

    function test_setProvider() public {
        vm.expectEmit(address(reg));
        emit IMarketRegistry.ProviderSet("api.example-sports.com", true);
        vm.prank(gov);
        reg.setProvider("api.example-sports.com", true);
        assertTrue(reg.providerAllowed("api.example-sports.com"));
        assertFalse(reg.providerAllowed("api.example-sports.co"));
        vm.prank(gov);
        reg.setProvider("api.example-sports.com", false);
        assertFalse(reg.providerAllowed("api.example-sports.com"));
    }

    function test_setAuthRef() public {
        bytes32 ref = keccak256("SPORTSDATA_V1");
        vm.expectEmit(address(reg));
        emit IMarketRegistry.AuthRefSet(ref, true);
        vm.prank(gov);
        reg.setAuthRef(ref, true);
        assertTrue(reg.authRefKnown(ref));
        vm.prank(gov);
        reg.setAuthRef(ref, false);
        assertFalse(reg.authRefKnown(ref));
    }

    function test_setCategory_stampsAndClearsValidatedAt() public {
        bytes32 id = keccak256("sports");
        vm.expectEmit(address(reg));
        emit IMarketRegistry.CategorySet(id, keccak256("gate"), 150, 300, true);
        vm.prank(gov);
        reg.setCategory(id, keccak256("gate"), 150, 300, true);
        Category memory c = reg.category(id);
        assertEq(c.gateHash, keccak256("gate"));
        assertEq(c.u95Bps, 150);
        assertEq(c.sampleN, 300);
        assertTrue(c.validated);
        assertEq(c.validatedAt, 1_800_000_000);

        // Any validated call restarts the clock, even with unchanged values.
        vm.warp(1_800_000_500);
        vm.prank(gov);
        reg.setCategory(id, keccak256("gate"), 150, 300, true);
        assertEq(reg.category(id).validatedAt, 1_800_000_500);

        // Revoking clears the stamp at once and keeps the recorded measurement.
        vm.warp(1_800_000_900);
        vm.prank(gov);
        reg.setCategory(id, keccak256("gate"), 150, 300, false);
        c = reg.category(id);
        assertFalse(c.validated);
        assertEq(c.validatedAt, 0);
        assertEq(c.gateHash, keccak256("gate"));
        assertEq(c.sampleN, 300);
    }

    function test_setLister() public {
        vm.expectEmit(address(reg));
        emit IMarketRegistry.ListerSet(stranger);
        vm.prank(gov);
        reg.setLister(stranger);
        assertEq(reg.lister(), stranger);
    }

    function test_setFactory() public {
        vm.expectEmit(address(reg));
        emit IMarketRegistry.FactorySet(address(0xFAC));
        vm.prank(gov);
        reg.setFactory(address(0xFAC));
        assertEq(reg.factory(), address(0xFAC));
        vm.prank(gov);
        reg.setFactory(address(0));
        assertEq(reg.factory(), address(0), "unset again: createMarket will revert NoFactory");
    }

    function test_unknownGroupAndCategoryAreEmpty() public view {
        assertFalse(reg.groupInfo(keccak256("g")).exists);
        assertFalse(reg.category(keccak256("c")).validated);
    }

    function test_settersAreGovernanceOnly() public {
        address[4] memory notGov = [stranger, lister, oracle, factory];
        for (uint256 i; i < notGov.length; ++i) {
            vm.startPrank(notGov[i]);
            vm.expectRevert(IMarketRegistry.Unauthorized.selector);
            reg.setGlobals(_testnet());
            vm.expectRevert(IMarketRegistry.Unauthorized.selector);
            reg.setProvider("api.example-sports.com", true);
            vm.expectRevert(IMarketRegistry.Unauthorized.selector);
            reg.setAuthRef(keccak256("x"), true);
            vm.expectRevert(IMarketRegistry.Unauthorized.selector);
            reg.setCategory(keccak256("c"), keccak256("g"), 1, 1, true);
            vm.expectRevert(IMarketRegistry.Unauthorized.selector);
            reg.setLister(notGov[i]);
            vm.expectRevert(IMarketRegistry.Unauthorized.selector);
            reg.setFactory(notGov[i]);
            vm.stopPrank();
        }
    }

    // ------------------------------------------------------------------ SSTORE2 text

    function test_textRoundTrip() public {
        RegistryTextHarness h = new RegistryTextHarness();
        assertEq(h.readText(address(0)), "", "unset pointer reads empty");
        assertEq(h.readText(h.writeText("")), "");
        string memory q = "Will the Lakers beat the Celtics on 2027-01-15?";
        assertEq(h.readText(h.writeText(q)), q);
        bytes memory big = new bytes(16_384);
        for (uint256 i; i < big.length; ++i) {
            big[i] = bytes1(uint8(32 + (i % 95)));
        }
        assertEq(h.readText(h.writeText(string(big))), string(big));
    }

    // ------------------------------------------------------------------ helpers

    function _withBufferMin(Globals memory g, uint32 v) internal pure returns (Globals memory) {
        g.bufferMinSecs = v;
        return g;
    }
}
