// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {Resolution, RState, TrustSet, TrustSetInput} from "../../src/types/OracleTypes.sol";
import {IResolutionOracle} from "../../src/interfaces/IResolutionOracle.sol";
import {ResolutionOracle} from "../../src/ResolutionOracle.sol";
import {ResolutionOracleHarness} from "../mocks/ResolutionOracleHarness.sol";
import {MockAssertionVenue} from "../mocks/MockAssertionVenue.sol";

/// @notice Task O14.1: constructor, trust sets (`BadTrustSet` codes 0-9, ADJ-31), activation, guardian
///         revocations, `initResolution`, the watchdog heartbeat and `watchdogOf` (plan §4.1, §6.4, D8).
contract OracleTrustSetsTest is Test {
    uint64 internal constant SELECTOR = 2183018362218727504; // Monad testnet (§7.1)

    address internal registry = makeAddr("registry");
    address internal treasury = makeAddr("treasury");
    address internal usdc = makeAddr("usdc");
    address internal gov = makeAddr("timelock");
    address internal guardian = makeAddr("guardian");
    address internal stranger = makeAddr("stranger");
    address internal forwarder = makeAddr("forwarder");
    address internal attestor = makeAddr("attestor");
    address internal watchdog = makeAddr("watchdog");

    MockAssertionVenue internal venue;
    ResolutionOracleHarness internal o;

    function setUp() public {
        vm.chainId(10143);
        venue = new MockAssertionVenue(usdc, 2e6);
        o = new ResolutionOracleHarness(registry, treasury, usdc, SELECTOR, gov, guardian);
    }

    // ------------------------------------------------------------------ fixtures

    function _committee() internal pure returns (address[] memory c) {
        c = new address[](3);
        (c[0], c[1], c[2]) = (address(0x1001), address(0x1002), address(0x1003)); // strictly ascending
    }

    function _set() internal view returns (TrustSetInput memory t) {
        t.forwarder = forwarder;
        t.production = false;
        t.runnerAttestor = attestor;
        t.committee = _committee();
        t.threshold = 2;
        t.watchdog = watchdog;
        t.venue = address(venue);
    }

    function _production() internal view returns (TrustSetInput memory t) {
        t = _set();
        t.production = true;
        t.workflowIds = [keccak256("workflow-old"), keccak256("workflow-new")];
        t.workflowOwner = address(0x0C4E);
    }

    function _create(TrustSetInput memory t) internal returns (uint32 id) {
        vm.prank(gov);
        id = o.createTrustSet(t);
    }

    function _rejects(TrustSetInput memory t, uint8 code) internal {
        vm.prank(gov);
        vm.expectRevert(abi.encodeWithSelector(IResolutionOracle.BadTrustSet.selector, code));
        o.createTrustSet(t);
    }

    // ------------------------------------------------------------------ constructor

    function test_constructor() public view {
        assertEq(o.registry(), registry);
        assertEq(o.treasury(), treasury);
        assertEq(o.usdc(), usdc);
        assertEq(o.monadChainSelector(), SELECTOR);
        assertEq(o.governance(), gov);
        assertEq(o.guardian(), guardian);
        assertTrue(o.simModeAllowed() && o.simMode(), "sim mode starts on off mainnet");
        assertEq(o.trustSetCount(), 0);
        assertEq(o.activeTrustSetId(), 0);
    }

    function test_constructor_noSimModeOnMainnet() public {
        vm.chainId(143);
        ResolutionOracle m = new ResolutionOracle(registry, treasury, usdc, 8481857512324358265, gov, guardian);
        assertFalse(m.simModeAllowed());
        assertFalse(m.simMode());
    }

    /// External, so `expectRevert` checks each deployment instead of ending the test at the first one.
    function deployOracle(address r, address t, address u, address g, address gd) external returns (address) {
        return address(new ResolutionOracle(r, t, u, 1, g, gd));
    }

    function test_constructor_rejectsZeroAddresses() public {
        address z = address(0);
        bytes4 err = ResolutionOracle.ZeroAddress.selector;
        vm.expectRevert(err);
        this.deployOracle(z, treasury, usdc, gov, guardian);
        vm.expectRevert(err);
        this.deployOracle(registry, z, usdc, gov, guardian);
        vm.expectRevert(err);
        this.deployOracle(registry, treasury, z, gov, guardian);
        vm.expectRevert(err);
        this.deployOracle(registry, treasury, usdc, z, guardian);
        vm.expectRevert(err);
        this.deployOracle(registry, treasury, usdc, gov, z);
        assertTrue(this.deployOracle(registry, treasury, usdc, gov, guardian) != address(0));
    }

    // ------------------------------------------------------------------ createTrustSet

    function test_create_storesAndCounts() public {
        vm.warp(1_800_000_000);
        vm.expectEmit(address(o));
        emit IResolutionOracle.TrustSetCreated(1, true);
        uint32 id = _create(_production());
        assertEq(id, 1);
        assertEq(_create(_set()), 2, "ids increase from 1");
        assertEq(o.trustSetCount(), 2);
        assertEq(o.activeTrustSetId(), 0, "creating does not activate");
        TrustSet memory s = o.trustSet(1);
        assertEq(keccak256(abi.encode(s.cfg)), keccak256(abi.encode(_production())), "stored as given");
        assertEq(s.createdAt, 1_800_000_000);
        assertFalse(s.workflowIdRevoked[0] || s.workflowIdRevoked[1] || s.attestorRevoked || s.watchdogRevoked);
    }

    function test_create_code1_forwarder() public {
        TrustSetInput memory t = _set();
        t.forwarder = address(0);
        _rejects(t, 1);
    }

    function test_create_code2_productionNeedsWorkflowId() public {
        TrustSetInput memory t = _production();
        t.workflowIds[0] = 0;
        _rejects(t, 2);
        t.production = false; // a sim set needs no workflow
        _create(t);
    }

    function test_create_code3_productionNeedsOwner() public {
        TrustSetInput memory t = _production();
        t.workflowOwner = address(0);
        _rejects(t, 3);
    }

    function test_create_code4_attestor() public {
        TrustSetInput memory t = _set();
        t.runnerAttestor = address(0);
        _rejects(t, 4);
    }

    function test_create_code5_committee() public {
        TrustSetInput memory t = _set();
        t.committee = new address[](0);
        _rejects(t, 5);
        t.committee = _committee();
        t.committee[0] = address(0);
        _rejects(t, 5);
        t.committee = _committee();
        (t.committee[0], t.committee[1]) = (t.committee[1], t.committee[0]); // not ascending
        _rejects(t, 5);
        t.committee = _committee();
        t.committee[2] = t.committee[1]; // duplicate
        _rejects(t, 5);
    }

    function test_create_code6_threshold() public {
        TrustSetInput memory t = _set();
        t.threshold = 0;
        _rejects(t, 6);
        t.threshold = 4;
        _rejects(t, 6);
        t.threshold = 3; // == committee length
        _create(t);
    }

    function test_create_code7_watchdog() public {
        TrustSetInput memory t = _set();
        t.watchdog = address(0);
        _rejects(t, 7);
    }

    function test_create_code8_venue() public {
        TrustSetInput memory t = _set();
        t.venue = address(0);
        _rejects(t, 8);
    }

    function test_create_code9_currency() public {
        TrustSetInput memory t = _set();
        t.venue = address(new MockAssertionVenue(makeAddr("other token"), 2e6));
        _rejects(t, 9);
    }

    function test_create_governanceOnly() public {
        address[3] memory callers = [guardian, stranger, registry];
        for (uint256 i; i < callers.length; ++i) {
            TrustSetInput memory t = _set();
            vm.prank(callers[i]);
            vm.expectRevert(IResolutionOracle.Unauthorized.selector);
            o.createTrustSet(t);
        }
    }

    // ------------------------------------------------------------------ activateTrustSet

    function test_activate() public {
        _create(_set());
        _create(_production());
        vm.expectEmit(address(o));
        emit IResolutionOracle.TrustSetActivated(2);
        vm.prank(gov);
        o.activateTrustSet(2);
        assertEq(o.activeTrustSetId(), 2);
        vm.prank(gov);
        o.activateTrustSet(1);
        assertEq(o.activeTrustSetId(), 1);
    }

    function test_activate_unknownSet() public {
        _create(_set());
        vm.startPrank(gov);
        vm.expectRevert(abi.encodeWithSelector(IResolutionOracle.BadTrustSet.selector, uint8(0)));
        o.activateTrustSet(0);
        vm.expectRevert(abi.encodeWithSelector(IResolutionOracle.BadTrustSet.selector, uint8(0)));
        o.activateTrustSet(2);
        vm.stopPrank();
    }

    function test_activate_governanceOnly() public {
        _create(_set());
        vm.prank(guardian);
        vm.expectRevert(IResolutionOracle.Unauthorized.selector);
        o.activateTrustSet(1);
    }

    // ------------------------------------------------------------------ guardian revocations

    function test_revokeWorkflowId() public {
        _create(_production());
        vm.expectEmit(address(o));
        emit IResolutionOracle.TrustSetRevoked(1, 0, keccak256("workflow-new"));
        vm.prank(guardian);
        o.revokeWorkflowId(1, keccak256("workflow-new"));
        TrustSet memory s = o.trustSet(1);
        assertFalse(s.workflowIdRevoked[0]);
        assertTrue(s.workflowIdRevoked[1]);
    }

    function test_revokeWorkflowId_notInSet() public {
        _create(_production());
        vm.startPrank(guardian);
        vm.expectRevert(abi.encodeWithSelector(IResolutionOracle.BadTrustSet.selector, uint8(2)));
        o.revokeWorkflowId(1, keccak256("other workflow"));
        vm.expectRevert(abi.encodeWithSelector(IResolutionOracle.BadTrustSet.selector, uint8(2)));
        o.revokeWorkflowId(1, 0);
        vm.stopPrank();
        _create(_set()); // a sim set: both slots are 0, and 0 is never a workflow ID
        vm.prank(guardian);
        vm.expectRevert(abi.encodeWithSelector(IResolutionOracle.BadTrustSet.selector, uint8(2)));
        o.revokeWorkflowId(2, 0);
    }

    function test_revokeAttestor() public {
        _create(_set());
        vm.expectEmit(address(o));
        emit IResolutionOracle.TrustSetRevoked(1, 1, bytes32(uint256(uint160(attestor))));
        vm.prank(guardian);
        o.revokeAttestor(1);
        assertTrue(o.trustSet(1).attestorRevoked);
    }

    function test_revokeCommitteeMember() public {
        _create(_set());
        address m = _committee()[1];
        vm.expectEmit(address(o));
        emit IResolutionOracle.TrustSetRevoked(1, 2, bytes32(uint256(uint160(m))));
        vm.prank(guardian);
        o.revokeCommitteeMember(1, m);
        assertTrue(o.isMemberRevoked(1, m));
        assertFalse(o.isMemberRevoked(1, _committee()[0]));
        vm.prank(guardian);
        vm.expectRevert(abi.encodeWithSelector(IResolutionOracle.NotCommitteeMember.selector, stranger));
        o.revokeCommitteeMember(1, stranger);
    }

    function test_revokeWatchdog() public {
        _create(_set());
        vm.expectEmit(address(o));
        emit IResolutionOracle.TrustSetRevoked(1, 3, bytes32(uint256(uint160(watchdog))));
        vm.prank(guardian);
        o.revokeWatchdog(1);
        assertTrue(o.trustSet(1).watchdogRevoked);
    }

    function test_revoke_unknownSet() public {
        vm.startPrank(guardian);
        vm.expectRevert(abi.encodeWithSelector(IResolutionOracle.BadTrustSet.selector, uint8(0)));
        o.revokeAttestor(1);
        vm.expectRevert(abi.encodeWithSelector(IResolutionOracle.BadTrustSet.selector, uint8(0)));
        o.revokeWatchdog(1);
        vm.expectRevert(abi.encodeWithSelector(IResolutionOracle.BadTrustSet.selector, uint8(0)));
        o.revokeCommitteeMember(1, address(0x1001));
        vm.expectRevert(abi.encodeWithSelector(IResolutionOracle.BadTrustSet.selector, uint8(0)));
        o.revokeWorkflowId(1, keccak256("x"));
        vm.stopPrank();
    }

    function test_revoke_guardianOnly() public {
        _create(_production());
        address[2] memory callers = [gov, stranger];
        for (uint256 i; i < callers.length; ++i) {
            vm.startPrank(callers[i]);
            vm.expectRevert(IResolutionOracle.Unauthorized.selector);
            o.revokeWorkflowId(1, keccak256("workflow-old"));
            vm.expectRevert(IResolutionOracle.Unauthorized.selector);
            o.revokeAttestor(1);
            vm.expectRevert(IResolutionOracle.Unauthorized.selector);
            o.revokeCommitteeMember(1, address(0x1001));
            vm.expectRevert(IResolutionOracle.Unauthorized.selector);
            o.revokeWatchdog(1);
            vm.stopPrank();
        }
    }

    // ------------------------------------------------------------------ initResolution

    function test_initResolution() public {
        bytes32 id = keccak256("market-1");
        vm.expectEmit(address(o));
        emit IResolutionOracle.ResolutionInitialized(id);
        vm.prank(registry);
        o.initResolution(id);
        assertEq(uint8(o.getResolution(id).state), uint8(RState.None));
        vm.prank(registry);
        vm.expectRevert(IResolutionOracle.AlreadyInitialized.selector);
        o.initResolution(id);
    }

    function test_initResolution_registryOnly() public {
        address[3] memory callers = [gov, guardian, stranger];
        for (uint256 i; i < callers.length; ++i) {
            vm.prank(callers[i]);
            vm.expectRevert(IResolutionOracle.Unauthorized.selector);
            o.initResolution(keccak256("market-1"));
        }
    }

    // ------------------------------------------------------------------ heartbeat and watchdogOf

    function test_heartbeat_anySetsWatchdog() public {
        _create(_set()); // never activated: its watchdog may still beat (markets may pin older sets)
        vm.warp(1_800_000_000);
        vm.expectEmit(address(o));
        emit IResolutionOracle.WatchdogHeartbeat(watchdog, 1_800_000_000);
        vm.prank(watchdog);
        o.watchdogHeartbeat();
        assertEq(o.lastHeartbeat(watchdog), 1_800_000_000);
    }

    function test_heartbeat_refusedForStrangersAndRevoked() public {
        vm.prank(watchdog);
        vm.expectRevert(IResolutionOracle.Unauthorized.selector);
        o.watchdogHeartbeat(); // no trust set yet
        _create(_set());
        _create(_set()); // the same watchdog in two sets
        vm.startPrank(guardian);
        o.revokeWatchdog(1);
        o.revokeWatchdog(1); // idempotent: counted once
        vm.stopPrank();
        vm.prank(watchdog);
        o.watchdogHeartbeat(); // still the watchdog of set 2
        vm.prank(guardian);
        o.revokeWatchdog(2);
        vm.prank(watchdog);
        vm.expectRevert(IResolutionOracle.Unauthorized.selector);
        o.watchdogHeartbeat();
        vm.prank(stranger);
        vm.expectRevert(IResolutionOracle.Unauthorized.selector);
        o.watchdogHeartbeat();
    }

    function test_watchdogOf_pinnedSetOnly() public {
        _create(_set());
        bytes32 id = keccak256("market-1");
        assertEq(o.watchdogOf(id), address(0), "unknown market");
        Resolution memory r;
        r.state = RState.L1Pending;
        o.setResolution(id, r);
        assertEq(o.watchdogOf(id), address(0), "not halted: nothing pinned");
        r.trustSetId = 1;
        o.setResolution(id, r);
        assertEq(o.watchdogOf(id), watchdog);
        vm.prank(guardian);
        o.revokeWatchdog(1);
        assertEq(o.watchdogOf(id), address(0), "revoked");
    }

    function test_unknownSetReadsEmpty() public view {
        assertEq(o.trustSet(7).cfg.forwarder, address(0));
        assertFalse(o.isMemberRevoked(7, address(0x1001)));
    }
}
