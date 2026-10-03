// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {MarketInput, Outcome, Path, RState, TrustSetInput} from "../../src/types/OracleTypes.sol";
import {IResolutionOracle} from "../../src/interfaces/IResolutionOracle.sol";
import {ResolutionOracle} from "../../src/ResolutionOracle.sol";
import {OracleFixture} from "./OracleFixture.sol";
import {MockKeystoneForwarderLite} from "../mocks/MockKeystoneForwarderLite.sol";

/// @notice Task O15.2: the sim-mode bridge and `lockProduction` (plan §6.4 "Sim mode lifecycle", §7.5,
///         §11.1 "Sim mode", §12.6, D13, ORC-13, V-C9). While sim mode is on, reports relayed through the
///         configured sim forwarder by an allowed `tx.origin` reach markets pinned to a non-production
///         set without metadata; production-forwarder reports keep working; `lockProduction` ends sim
///         mode for good, and sim mode never exists on chainId 143.
/// @dev Fixture as on testnet (§12.5): trust set 1 is the sim set whose forwarder is the
///      MockKeystoneForwarder, which governance also sets as the sim forwarder; trust set 2 is a production
///      set whose forwarder is `MockKeystoneForwarderLite`. Market S halted at T pinned to set 1, market P
///      halted at T pinned to set 2; buffer 60 s, so reports observe T + 60.
contract OracleSimModeTest is OracleFixture {
    bytes32 internal constant WF = keccak256("workflow");
    address internal constant ORG = address(0x0C4E);
    uint64 internal constant OBSERVED = T + 60;
    bytes32 internal constant VALUE_HASH = keccak256("3");

    address internal relayer = makeAddr("sim relayer"); // CRE_ETH_PRIVATE_KEY of `cre workflow simulate --broadcast`
    MockKeystoneForwarderLite internal keystone; // production forwarder of set 2
    bytes32 internal idS; // pinned to the sim set 1
    bytes32 internal idP; // pinned to the production set 2

    function setUp() public override {
        super.setUp();
        keystone = new MockKeystoneForwarderLite();
        vm.startPrank(gov);
        ro.setSimForwarder(mockForwarder);
        ro.setSimRelayer(relayer, true);
        vm.stopPrank();
        idS = _listAs("market-sim");
        idP = _listAs("market-prod");
        vm.warp(T);
        ro.haltScheduled(idS); // pins set 1
        vm.startPrank(gov);
        ro.createTrustSet(_production()); // set 2
        ro.activateTrustSet(2);
        vm.stopPrank();
        ro.haltScheduled(idP); // pins set 2
        vm.warp(OBSERVED);
    }

    // ------------------------------------------------------------------ helpers

    function _listAs(string memory name) internal returns (bytes32 id) {
        MarketInput memory m = _market();
        m.marketId = keccak256(bytes(name));
        id = m.marketId;
        _list(m);
    }

    function _production() internal view returns (TrustSetInput memory t) {
        t = _trustSet();
        t.forwarder = address(keystone);
        t.production = true;
        t.workflowIds = [WF, bytes32(0)];
        t.workflowOwner = ORG;
    }

    function _report(bytes32 market) internal view returns (bytes memory) {
        return _report(market, SELECTOR, OBSERVED);
    }

    function _report(bytes32 market, uint64 selector, uint64 observedAt) internal view returns (bytes memory) {
        return abi.encode(
            uint8(1), selector, address(ro), market, uint8(1), observedAt, VALUE_HASH, keccak256(abi.encode(_feed()))
        );
    }

    function _prodMeta() internal pure returns (bytes memory) {
        return abi.encodePacked(WF, bytes10(0), ORG, bytes2(0x0001));
    }

    /// A report delivered by `sender` in a transaction sent by `origin`.
    function _send(address sender, address origin, bytes memory meta, bytes memory report) internal {
        vm.prank(sender, origin);
        ro.onReport(meta, report);
    }

    function _rejects(address sender, address origin, bytes memory meta, bytes memory report, bytes memory err)
        internal
    {
        vm.prank(sender, origin);
        vm.expectRevert(err);
        ro.onReport(meta, report);
    }

    function _err(bytes4 selector) internal pure returns (bytes memory) {
        return abi.encodeWithSelector(selector);
    }

    function _lock() internal {
        vm.prank(gov);
        ro.lockProduction();
    }

    // ------------------------------------------------------------------ governance setters

    /// setSimForwarder and setSimRelayer: Timelock only, events, stored values.
    function test_setters() public {
        uint256 snap = vm.snapshotState();
        {
            // test_setSimForwarder
            assertEq(ro.simForwarder(), mockForwarder, "set in setUp");
            vm.expectEmit(address(ro));
            emit IResolutionOracle.SimForwarderSet(address(0xF0));
            vm.prank(gov);
            ro.setSimForwarder(address(0xF0));
            assertEq(ro.simForwarder(), address(0xF0));
            vm.prank(gov);
            ro.setSimForwarder(address(0)); // switches the sim path off without ending sim mode
            assertEq(ro.simForwarder(), address(0));
        }
        vm.revertToState(snap);
        {
            // test_setSimRelayer
            address other = makeAddr("other relayer");
            assertTrue(ro.isSimRelayer(relayer));
            assertFalse(ro.isSimRelayer(other));
            vm.expectEmit(address(ro));
            emit IResolutionOracle.SimRelayerSet(other, true);
            vm.prank(gov);
            ro.setSimRelayer(other, true);
            assertTrue(ro.isSimRelayer(other));
            vm.prank(gov);
            ro.setSimRelayer(relayer, false);
            assertFalse(ro.isSimRelayer(relayer));
        }
        vm.revertToState(snap);
        {
            // test_setters_governanceOnly
            address[3] memory callers = [guardian, relayer, mockForwarder];
            for (uint256 i; i < callers.length; ++i) {
                vm.startPrank(callers[i]);
                vm.expectRevert(IResolutionOracle.Unauthorized.selector);
                ro.setSimForwarder(callers[i]);
                vm.expectRevert(IResolutionOracle.Unauthorized.selector);
                ro.setSimRelayer(callers[i], true);
                vm.expectRevert(IResolutionOracle.Unauthorized.selector);
                ro.lockProduction();
                vm.stopPrank();
            }
        }
    }

    // ------------------------------------------------------------------ the sim path

    /// Sim path: the sim forwarder with an allowed tx.origin reaches a sim-pinned market, metadata skipped;
    /// the report itself is still checked in full.
    function test_simPath_accepted() public {
        uint256 snap = vm.snapshotState();
        {
            // test_sim_proposesL1WithoutMetadata
            bytes memory report = _report(idS);
            vm.expectEmit(address(ro));
            emit IResolutionOracle.ProposedL1(idS, Outcome.YES, OBSERVED, VALUE_HASH, keccak256(report));
            _send(mockForwarder, relayer, "", report);
            assertEq(uint8(_state(idS)), uint8(RState.Proposed));
            assertEq(uint8(_res(idS).path), uint8(Path.L1));
            assertEq(_res(idS).evidenceHash, keccak256(report));
        }
        vm.revertToState(snap);
        {
            // test_sim_anyMetadataIgnored
            _send(
                mockForwarder,
                relayer,
                abi.encodePacked(keccak256("any workflow"), bytes10("x"), address(1)),
                _report(idS)
            );
            assertEq(uint8(_state(idS)), uint8(RState.Proposed));
        }
        vm.revertToState(snap);
        {
            // test_sim_throughAHeaderFaithfulForwarder (the relayer's transaction calls the mock forwarder)
            MockKeystoneForwarderLite simFwd = new MockKeystoneForwarderLite();
            vm.prank(gov);
            ro.setSimForwarder(address(simFwd));
            MockKeystoneForwarderLite.Header memory h;
            h.executionId = keccak256("sim execution");
            bytes memory raw = simFwd.rawReport(h, _report(idS)); // the simulator's zero header fields
            vm.prank(relayer, relayer);
            assertTrue(simFwd.report(address(ro), raw));
            assertEq(uint8(_state(idS)), uint8(RState.Proposed));
        }
        vm.revertToState(snap);
        {
            // test_sim_reportContentStillChecked
            _rejects(
                mockForwarder,
                relayer,
                "",
                _report(idS, 8481857512324358265, OBSERVED),
                abi.encodeWithSelector(IResolutionOracle.BadReport.selector, uint8(2))
            );
            _rejects(
                mockForwarder,
                relayer,
                "",
                _report(idS, SELECTOR, OBSERVED - 1),
                abi.encodeWithSelector(IResolutionOracle.BadReport.selector, uint8(6))
            );
            _send(mockForwarder, relayer, "", _report(idS));
            _rejects(
                mockForwarder,
                relayer,
                "",
                _report(idS),
                abi.encodeWithSelector(IResolutionOracle.WrongState.selector, RState.Proposed)
            );
        }
    }

    /// Sim path refusals: tx.origin not (or no longer) a relayer, a production-pinned market, a sender
    /// that is not the configured sim forwarder.
    function test_simPath_refused() public {
        bytes memory unauthorized = _err(IResolutionOracle.Unauthorized.selector);
        uint256 snap = vm.snapshotState();
        {
            // test_sim_originNotARelayer
            _rejects(mockForwarder, makeAddr("stranger"), "", _report(idS), unauthorized);
            _rejects(mockForwarder, mockForwarder, "", _report(idS), unauthorized);
            vm.prank(gov);
            ro.setSimRelayer(relayer, false);
            _rejects(mockForwarder, relayer, "", _report(idS), unauthorized);
            assertEq(uint8(_state(idS)), uint8(RState.L1Pending));
        }
        vm.revertToState(snap);
        {
            // test_sim_productionPinnedMarketRefused (a sim report never reaches a production market)
            _rejects(mockForwarder, relayer, "", _report(idP), unauthorized);
            _rejects(mockForwarder, relayer, _prodMeta(), _report(idP), unauthorized);
            assertEq(uint8(_state(idP)), uint8(RState.L1Pending));
        }
        vm.revertToState(snap);
        {
            // test_sim_onlyTheConfiguredSimForwarder (other senders take the production path)
            _rejects(makeAddr("stranger"), relayer, "", _report(idS), unauthorized);
            vm.prank(gov);
            ro.setSimForwarder(address(0));
            // The sim set's own forwarder is then a production-path sender, and the set is not production.
            _rejects(mockForwarder, relayer, "", _report(idS), _err(IResolutionOracle.ProductionSetRequired.selector));
        }
    }

    // ------------------------------------------------------------------ production path during sim mode

    /// While sim mode is on, the production forwarder still delivers to production-pinned markets (E10,
    /// the staging switch) and the production path keeps all its checks.
    function test_productionWhileSimModeOn() public {
        assertTrue(ro.simMode());
        uint256 snap = vm.snapshotState();
        {
            // test_production_acceptedWhileSimModeOn
            _send(address(keystone), makeAddr("don transmitter"), _prodMeta(), _report(idP));
            assertEq(uint8(_state(idP)), uint8(RState.Proposed));
        }
        vm.revertToState(snap);
        {
            // test_production_throughTheForwarderWhileSimModeOn
            MockKeystoneForwarderLite.Header memory h;
            h.executionId = keccak256("execution");
            h.workflowId = WF;
            h.workflowOwner = ORG;
            assertTrue(keystone.report(address(ro), keystone.rawReport(h, _report(idP))));
            assertEq(uint8(_state(idP)), uint8(RState.Proposed));
        }
        vm.revertToState(snap);
        {
            // test_production_metadataStillRequired (a relayer origin grants nothing on the production path)
            _rejects(address(keystone), relayer, "", _report(idP), _err(IResolutionOracle.BadMetadata.selector));
            _rejects(
                address(keystone), relayer, _prodMeta(), _report(idS), _err(IResolutionOracle.Unauthorized.selector)
            );
        }
    }

    // ------------------------------------------------------------------ lockProduction

    /// lockProduction: needs an active, working production set; ends sim mode for good (ORC-13).
    function test_lockProduction() public {
        bytes memory productionRequired = _err(IResolutionOracle.ProductionSetRequired.selector);
        uint256 snap = vm.snapshotState();
        {
            // test_lock_endsSimMode
            vm.expectEmit(address(ro));
            emit IResolutionOracle.ProductionLocked();
            _lock();
            assertFalse(ro.simMode());
            assertEq(ro.simForwarder(), address(0), "cleared");
            assertTrue(ro.simModeAllowed(), "the chain still allows it; the lock is what ends it");
            assertTrue(ro.isSimRelayer(relayer), "kept, but unreachable without sim mode");
        }
        vm.revertToState(snap);
        {
            // test_lock_mockForwarderReportReverts (E11, ORC-13)
            _lock();
            _rejects(mockForwarder, relayer, "", _report(idS), productionRequired);
            assertEq(uint8(_state(idS)), uint8(RState.L1Pending), "the market times out into Layer 2");
            vm.warp(T + 300);
            assertTrue(ro.escalateToL2(idS));
        }
        vm.revertToState(snap);
        {
            // test_lock_productionReportsKeepWorking
            _lock();
            _send(address(keystone), address(this), _prodMeta(), _report(idP));
            assertEq(uint8(_state(idP)), uint8(RState.Proposed));
        }
        vm.revertToState(snap);
        {
            // test_lock_isOneWay (the setters refuse, so sim mode cannot be turned back on)
            _lock();
            vm.startPrank(gov);
            vm.expectRevert(IResolutionOracle.SimModeOff.selector);
            ro.setSimForwarder(mockForwarder);
            vm.expectRevert(IResolutionOracle.SimModeOff.selector);
            ro.setSimRelayer(relayer, true);
            ro.lockProduction(); // repeating it is harmless
            vm.stopPrank();
            assertFalse(ro.simMode());
        }
        vm.revertToState(snap);
        {
            // test_lock_needsAnActiveProductionSet
            vm.prank(gov);
            ro.activateTrustSet(1); // the sim set
            vm.prank(gov);
            vm.expectRevert(productionRequired);
            ro.lockProduction();
            TrustSetInput memory sim = _production();
            sim.production = false; // a sim set that names a workflow and its owner is still a sim set
            vm.startPrank(gov);
            ro.createTrustSet(sim); // set 3
            ro.activateTrustSet(3);
            vm.expectRevert(productionRequired);
            ro.lockProduction();
            vm.stopPrank();
            assertTrue(ro.simMode());
        }
        vm.revertToState(snap);
        {
            // test_lock_needsAWorkingWorkflowId (every ID of the active set revoked)
            vm.prank(guardian);
            ro.revokeWorkflowId(2, WF);
            vm.prank(gov);
            vm.expectRevert(productionRequired);
            ro.lockProduction();
            TrustSetInput memory t = _production();
            t.workflowIds = [keccak256("old"), WF];
            vm.startPrank(gov);
            ro.createTrustSet(t); // set 3: a redeploy pair, the new ID still valid
            ro.activateTrustSet(3);
            vm.stopPrank();
            vm.prank(guardian);
            ro.revokeWorkflowId(3, keccak256("old"));
            _lock();
            assertFalse(ro.simMode());
        }
        vm.revertToState(snap);
        {
            // test_lock_simSetActivatedLaterGetsNoReports (D13: such markets time out into Layer 2)
            _lock();
            MarketInput memory m = _market();
            m.marketId = keccak256("market-late");
            m.tau = OBSERVED + 600; // the minimum horizon from now
            _list(m);
            vm.prank(gov);
            ro.activateTrustSet(1); // governance can still activate a sim set after the lock
            vm.warp(m.tau);
            ro.haltScheduled(m.marketId);
            assertEq(_res(m.marketId).trustSetId, 1);
            vm.warp(m.tau + 60);
            _rejects(mockForwarder, relayer, "", _report(m.marketId, SELECTOR, m.tau + 60), productionRequired);
        }
    }

    // ------------------------------------------------------------------ chainId 143

    /// On Monad mainnet sim mode never exists: off from the constructor, setters refuse, lockProduction works.
    function test_mainnet_noSimMode() public {
        vm.chainId(143);
        ResolutionOracle m =
            new ResolutionOracle(address(reg), address(treasury), usdc, 8481857512324358265, gov, guardian);
        assertFalse(m.simModeAllowed());
        assertFalse(m.simMode());
        vm.startPrank(gov);
        vm.expectRevert(IResolutionOracle.SimModeOff.selector);
        m.setSimForwarder(mockForwarder);
        vm.expectRevert(IResolutionOracle.SimModeOff.selector);
        m.setSimRelayer(relayer, true);
        vm.expectRevert(IResolutionOracle.ProductionSetRequired.selector);
        m.lockProduction(); // no trust set yet
        m.createTrustSet(_production());
        m.activateTrustSet(1);
        vm.expectEmit(address(m));
        emit IResolutionOracle.ProductionLocked();
        m.lockProduction(); // §12.6: called before the first mainnet listing
        vm.stopPrank();
        assertFalse(m.simMode());
        assertEq(m.simForwarder(), address(0));
    }
}
