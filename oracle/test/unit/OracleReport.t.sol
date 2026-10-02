// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {FeedSpec, MarketInput, Outcome, Path, Resolution, RState, TrustSetInput} from "../../src/types/OracleTypes.sol";
import {IResolutionOracle} from "../../src/interfaces/IResolutionOracle.sol";
import {IReceiver} from "../../src/interfaces/IReceiver.sol";
import {OracleFixture} from "./OracleFixture.sol";
import {MockKeystoneForwarderLite} from "../mocks/MockKeystoneForwarderLite.sol";
import {MockResolutionEngine} from "../mocks/MockResolutionEngine.sol";

/// @notice Task O15.1: the CRE receiver's production path (plan §6.4 `onReport`, §7.1, §11.1 "onReport",
///         "Replay"; D12, ORC-4, V-C7, V-C8): authentication against the market's pinned trust set, report
///         v1 decoding with `BadReport` codes 1-6, the L1 proposal, replays, ERC-165 and the gas budget.
/// @dev Fixture: a production trust set (id 2) whose forwarder is `MockKeystoneForwarderLite`, accepting
///      workflow IDs [old, new] of the CRE org owner, is active when the feed market halts at T. Buffer 60 s,
///      so the earliest valid `observedAt` is T + 60; L1 liveness 120 s, L1 timeout 300 s. Expected
///      reports are built here as the workflow (Appendix B.1) encodes them.
contract OracleReportTest is OracleFixture {
    bytes32 internal constant WF_OLD = keccak256("workflow-old");
    bytes32 internal constant WF_NEW = keccak256("workflow-new");
    address internal constant ORG = address(0x0C4E); // CRE org owner (private registry)
    bytes10 internal constant NAME = bytes10("eros-res");
    uint64 internal constant OBSERVED = T + 60; // T + bufferSecs
    bytes32 internal constant VALUE_HASH = keccak256("3");
    string internal constant L1_URL = "https://api.example-sports.com/v1/events/evt_1";

    MockKeystoneForwarderLite internal fwd;
    bytes32 internal id; // feed market, halted at T, pinned to the production set 2
    bytes32 internal idB; // second feed market, still pre-halt
    MockResolutionEngine internal engine;

    /// Report v1 words, each a full uint256 so malformed values can be built (Appendix B.1 layout).
    struct Words {
        uint256 v;
        uint256 sel;
        uint256 oracle;
        bytes32 id;
        uint256 outcome;
        uint256 observedAt;
        bytes32 valueHash;
        bytes32 specHash;
    }

    function setUp() public override {
        super.setUp();
        fwd = new MockKeystoneForwarderLite();
        vm.startPrank(gov);
        ro.createTrustSet(_production(address(fwd), bytes10(0))); // set 2
        ro.activateTrustSet(2);
        vm.stopPrank();
        (id, engine) = _listFeed();
        MarketInput memory b = _market();
        b.marketId = keccak256("market-b");
        idB = b.marketId;
        _list(b);
        vm.warp(T);
        ro.haltScheduled(id);
        vm.warp(OBSERVED);
    }

    // ------------------------------------------------------------------ helpers

    function _production(address forwarder, bytes10 name) internal view returns (TrustSetInput memory t) {
        t = _trustSet();
        t.forwarder = forwarder;
        t.production = true;
        t.workflowIds = [WF_OLD, WF_NEW];
        t.workflowOwner = ORG;
        t.workflowName = name;
    }

    /// Creates and activates a trust set, then halts market B so it pins that set.
    function _pinB(TrustSetInput memory t) internal returns (uint32 setId) {
        vm.startPrank(gov);
        setId = ro.createTrustSet(t);
        ro.activateTrustSet(setId);
        vm.stopPrank();
        ro.haltScheduled(idB);
    }

    function _specHash() internal pure returns (bytes32) {
        FeedSpec memory f = _feed();
        return keccak256(abi.encode(f));
    }

    /// The report exactly as the workflow encodes it (Appendix B.1 step 5).
    function _report(bytes32 market, uint8 outcome, uint64 observedAt) internal view returns (bytes memory) {
        return abi.encode(
            uint8(1), SELECTOR, address(ro), market, outcome, observedAt, VALUE_HASH, keccak256(abi.encode(_feed()))
        );
    }

    function _report(bytes32 market) internal view returns (bytes memory) {
        return _report(market, uint8(Outcome.YES), OBSERVED);
    }

    function _words(bytes32 market) internal view returns (Words memory w) {
        w = Words(1, SELECTOR, uint256(uint160(address(ro))), market, 1, OBSERVED, VALUE_HASH, _specHash());
    }

    function _encode(Words memory w) internal pure returns (bytes memory) {
        return abi.encode(w.v, w.sel, w.oracle, w.id, w.outcome, w.observedAt, w.valueHash, w.specHash);
    }

    /// The 64-byte production metadata: workflowId ‖ workflowName ‖ workflowOwner ‖ reportId.
    function _meta(bytes32 workflowId, bytes10 name, address owner) internal pure returns (bytes memory) {
        return abi.encodePacked(workflowId, name, owner, bytes2(0x0001));
    }

    function _meta() internal pure returns (bytes memory) {
        return _meta(WF_OLD, NAME, ORG);
    }

    function _deliver(bytes memory meta, bytes memory report) internal {
        vm.prank(address(fwd));
        ro.onReport(meta, report);
    }

    function _rejects(address from, bytes memory meta, bytes memory report, bytes memory err) internal {
        vm.prank(from);
        vm.expectRevert(err);
        ro.onReport(meta, report);
    }

    function _rejects(bytes memory meta, bytes memory report, bytes memory err) internal {
        _rejects(address(fwd), meta, report, err);
    }

    function _badReport(Words memory w, uint8 code) internal {
        _rejects(_meta(), _encode(w), abi.encodeWithSelector(IResolutionOracle.BadReport.selector, code));
    }

    function _header(bytes32 executionId) internal pure returns (MockKeystoneForwarderLite.Header memory h) {
        h.executionId = executionId;
        h.timestamp = uint32(OBSERVED);
        h.donId = 1;
        h.donConfigVersion = 1;
        h.workflowId = WF_OLD;
        h.workflowName = NAME;
        h.workflowOwner = ORG;
        h.reportId = bytes2(0x0001);
    }

    // ------------------------------------------------------------------ ERC-165

    function test_supportsInterface() public view {
        assertTrue(ro.supportsInterface(0x805f2132), "IReceiver");
        assertTrue(ro.supportsInterface(type(IReceiver).interfaceId));
        assertTrue(ro.supportsInterface(0x01ffc9a7), "IERC165");
        assertFalse(ro.supportsInterface(0xffffffff), "ERC-165 requires false for 0xffffffff");
        assertFalse(ro.supportsInterface(0x12345678));
    }

    // ------------------------------------------------------------------ accepted reports

    /// Accepted reports: YES and NO become L1 proposals; both workflow IDs, 62- and 64-byte metadata,
    /// an unchecked name, the observedAt boundaries; the proposal then asserts with the L1 evidence.
    function test_accept() public {
        uint256 snap = vm.snapshotState();
        {
            // test_accept_proposesL1
            bytes memory report = _report(id);
            assertEq(report.length, 256);
            vm.expectEmit(address(ro));
            emit IResolutionOracle.StateChanged(id, RState.L1Pending, RState.Proposed);
            vm.expectEmit(address(ro));
            emit IResolutionOracle.ProposedL1(id, Outcome.YES, OBSERVED, VALUE_HASH, keccak256(report));
            _deliver(_meta(), report);
            Resolution memory r = _res(id);
            assertEq(uint8(r.state), uint8(RState.Proposed));
            assertEq(uint8(r.proposed), uint8(Outcome.YES));
            assertEq(uint8(r.path), uint8(Path.L1));
            assertEq(r.evidenceHash, keccak256(report), "evidenceHash = keccak256(report)");
            assertEq(r.valueHash, VALUE_HASH);
            assertEq(r.attempts, 0, "asserted later by assertProposal");
            assertEq(r.assertionId, 0);
            assertEq(engine.settleCalls(), 0, "no engine call");
            (uint8 state,,,) = ro.getL1Job(id);
            assertEq(state, uint8(RState.Proposed), "the workflow now skips this market");
        }
        vm.revertToState(snap);
        {
            // test_accept_no
            _deliver(_meta(), _report(id, uint8(Outcome.NO), OBSERVED));
            assertEq(uint8(_res(id).proposed), uint8(Outcome.NO));
        }
        vm.revertToState(snap);
        {
            // test_accept_secondWorkflowId (the [old, new] pair of a redeploy, §12.8)
            _deliver(_meta(WF_NEW, NAME, ORG), _report(id));
            assertEq(uint8(_state(id)), uint8(RState.Proposed));
        }
        vm.revertToState(snap);
        {
            // test_accept_62ByteMetadata (metadata.length >= 62; the reportId is not read)
            bytes memory meta = abi.encodePacked(WF_OLD, NAME, ORG);
            assertEq(meta.length, 62);
            _deliver(meta, _report(id));
            assertEq(uint8(_state(id)), uint8(RState.Proposed));
        }
        vm.revertToState(snap);
        {
            // test_accept_nameUncheckedWhenUnset (the pinned set's workflowName is 0)
            _deliver(_meta(WF_OLD, bytes10("anything"), ORG), _report(id));
            assertEq(uint8(_state(id)), uint8(RState.Proposed));
        }
        vm.revertToState(snap);
        {
            // test_accept_observedAtUpToNow
            vm.warp(T + 250);
            _deliver(_meta(), _report(id, uint8(Outcome.YES), T + 250));
            assertEq(uint8(_state(id)), uint8(RState.Proposed));
        }
        vm.revertToState(snap);
        {
            // test_accept_thenAssertsWithTheL1Evidence
            bytes memory report = _report(id);
            _deliver(_meta(), report);
            vm.prank(watchdog);
            ro.watchdogHeartbeat();
            assertTrue(ro.assertProposal(id));
            bytes32 aid = _res(id).assertionId;
            assertEq(mvenue.statusOf(aid).expiresAt, OBSERVED + 120, "L1 liveness with a fresh watchdog");
            string memory claim = string(mvenue.claimOf(aid));
            string memory evidence = string.concat(
                "Evidence: Layer 1 CRE report, value ",
                vm.toString(VALUE_HASH),
                ", source ",
                L1_URL,
                ", keccak256 ",
                vm.toString(keccak256(report))
            );
            assertTrue(_contains(claim, evidence), "the claim names the value hash, the source and the report");
        }
    }

    // ------------------------------------------------------------------ authentication

    /// Sender and set: only the pinned set's forwarder, only a production set, pinning survives activation.
    function test_auth_forwarderAndSet() public {
        uint256 snap = vm.snapshotState();
        {
            // test_auth_wrongSender
            bytes memory unauthorized = abi.encodeWithSelector(IResolutionOracle.Unauthorized.selector);
            _rejects(makeAddr("stranger"), _meta(), _report(id), unauthorized);
            _rejects(mockForwarder, _meta(), _report(id), unauthorized); // the sim set's forwarder
            _rejects(address(ro), _meta(), _report(id), unauthorized);
        }
        vm.revertToState(snap);
        {
            // test_auth_pinnedSetOnly (a set activated after the halt does not move the market's forwarder)
            MockKeystoneForwarderLite other = new MockKeystoneForwarderLite();
            vm.startPrank(gov);
            ro.createTrustSet(_production(address(other), bytes10(0)));
            ro.activateTrustSet(3);
            vm.stopPrank();
            _rejects(
                address(other), _meta(), _report(id), abi.encodeWithSelector(IResolutionOracle.Unauthorized.selector)
            );
            _deliver(_meta(), _report(id));
            assertEq(uint8(_state(id)), uint8(RState.Proposed));
        }
        vm.revertToState(snap);
        {
            // test_auth_nonProductionSetRefused (a market pinned to the sim set gets no production report)
            vm.prank(gov);
            ro.activateTrustSet(1);
            ro.haltScheduled(idB);
            assertEq(_res(idB).trustSetId, 1);
            _rejects(
                mockForwarder,
                _meta(),
                _report(idB),
                abi.encodeWithSelector(IResolutionOracle.ProductionSetRequired.selector)
            );
            assertEq(uint8(_state(idB)), uint8(RState.L1Pending));
        }
    }

    /// Metadata: at least 62 bytes; workflow ID accepted and not revoked (never 0); owner; name when set.
    function test_auth_metadata() public {
        bytes memory wrong = abi.encodeWithSelector(IResolutionOracle.WrongWorkflow.selector);
        uint256 snap = vm.snapshotState();
        {
            // test_auth_shortMetadata
            bytes memory badMeta = abi.encodeWithSelector(IResolutionOracle.BadMetadata.selector);
            _rejects(abi.encodePacked(WF_OLD, NAME, bytes19(bytes20(ORG))), _report(id), badMeta); // 61 bytes
            _rejects("", _report(id), badMeta);
        }
        vm.revertToState(snap);
        {
            // test_auth_unknownWorkflowId
            _rejects(_meta(keccak256("another workflow"), NAME, ORG), _report(id), wrong);
        }
        vm.revertToState(snap);
        {
            // test_auth_zeroWorkflowIdNeverMatchesAnEmptySlot
            TrustSetInput memory t = _production(address(fwd), bytes10(0));
            t.workflowIds = [WF_OLD, bytes32(0)];
            _pinB(t);
            _rejects(_meta(bytes32(0), NAME, ORG), _report(idB), wrong);
            _deliver(_meta(), _report(idB));
            assertEq(uint8(_state(idB)), uint8(RState.Proposed));
        }
        vm.revertToState(snap);
        {
            // test_auth_revokedWorkflowId (revocation applies to the pinned set at once)
            vm.prank(guardian);
            ro.revokeWorkflowId(2, WF_OLD);
            _rejects(_meta(WF_OLD, NAME, ORG), _report(id), wrong);
            _deliver(_meta(WF_NEW, NAME, ORG), _report(id));
            assertEq(uint8(_state(id)), uint8(RState.Proposed));
        }
        vm.revertToState(snap);
        {
            // test_auth_wrongOwner
            _rejects(_meta(WF_OLD, NAME, makeAddr("other org")), _report(id), wrong);
            _rejects(_meta(WF_OLD, NAME, address(0)), _report(id), wrong);
        }
        vm.revertToState(snap);
        {
            // test_auth_nameCheckedWhenSet
            _pinB(_production(address(fwd), NAME));
            _rejects(_meta(WF_OLD, bytes10("other"), ORG), _report(idB), wrong);
            _rejects(_meta(WF_OLD, bytes10(0), ORG), _report(idB), wrong);
            _deliver(_meta(WF_OLD, NAME, ORG), _report(idB));
            assertEq(uint8(_state(idB)), uint8(RState.Proposed));
        }
    }

    // ------------------------------------------------------------------ report content

    /// BadReport codes 1-6, each on both sides of its rule; malformed words never decode silently.
    function test_reportContent() public {
        bytes memory bad1 = abi.encodeWithSelector(IResolutionOracle.BadReport.selector, uint8(1));
        uint256 snap = vm.snapshotState();
        {
            // test_report_code1_length (exactly the 256-byte v1 layout)
            bytes memory report = _report(id);
            _rejects(_meta(), bytes.concat(report, hex"00"), bad1);
            _rejects(_meta(), _slice(report, 255), bad1);
            _rejects(_meta(), "", bad1);
        }
        vm.revertToState(snap);
        {
            // test_report_code1_version
            Words memory w = _words(id);
            uint256[3] memory bad = [uint256(0), 2, 257];
            for (uint256 i; i < bad.length; ++i) {
                w.v = bad[i];
                _badReport(w, 1);
            }
        }
        vm.revertToState(snap);
        {
            // test_report_code2_selector
            Words memory w = _words(id);
            w.sel = 8481857512324358265; // Monad mainnet selector on testnet
            _badReport(w, 2);
            w.sel = uint256(SELECTOR) + (1 << 64); // the right low 64 bits, a dirty word
            _badReport(w, 2);
        }
        vm.revertToState(snap);
        {
            // test_report_code3_oracle
            Words memory w = _words(id);
            w.oracle = uint256(uint160(makeAddr("another oracle")));
            _badReport(w, 3);
            w.oracle = uint256(uint160(address(ro))) | (1 << 200); // dirty high bits
            _badReport(w, 3);
        }
        vm.revertToState(snap);
        {
            // test_report_code4_outcome (Layer 1 writes YES or NO only, never INVALID)
            Words memory w = _words(id);
            uint256[4] memory bad = [uint256(0), 3, 4, 257];
            for (uint256 i; i < bad.length; ++i) {
                w.outcome = bad[i];
                _badReport(w, 4);
            }
        }
        vm.revertToState(snap);
        {
            // test_report_code5_specHash
            Words memory w = _words(id);
            w.specHash = keccak256("another spec");
            _badReport(w, 5);
            FeedSpec memory zero;
            w.specHash = keccak256(abi.encode(zero));
            _badReport(w, 5);
        }
        vm.revertToState(snap);
        {
            // test_report_code6_observedAt (T + bufferSecs <= observedAt <= now)
            Words memory w = _words(id);
            w.observedAt = OBSERVED - 1;
            _badReport(w, 6);
            w.observedAt = OBSERVED + 1; // after block.timestamp
            _badReport(w, 6);
            w.observedAt = uint256(OBSERVED) + (1 << 64); // the right low 64 bits, a dirty word
            _badReport(w, 6);
            w.observedAt = OBSERVED;
            _deliver(_meta(), _encode(w));
            assertEq(uint8(_state(id)), uint8(RState.Proposed));
        }
    }

    // ------------------------------------------------------------------ state and replays (ORC-4)

    /// Only L1Pending accepts a report: unknown and pre-halt markets, and replays after the proposal,
    /// the escalation and Final, all revert and change nothing.
    function test_state() public {
        uint256 snap = vm.snapshotState();
        {
            // test_state_unknownMarket
            _rejects(
                _meta(),
                _report(keccak256("never listed")),
                abi.encodeWithSelector(IResolutionOracle.UnknownMarket.selector)
            );
        }
        vm.revertToState(snap);
        {
            // test_state_preHalt
            _rejects(_meta(), _report(idB), abi.encodeWithSelector(IResolutionOracle.WrongState.selector, RState.None));
        }
        vm.revertToState(snap);
        {
            // test_state_replayAfterProposal
            bytes memory first = _report(id);
            _deliver(_meta(), first);
            bytes memory wrongState = abi.encodeWithSelector(IResolutionOracle.WrongState.selector, RState.Proposed);
            _rejects(_meta(), first, wrongState);
            _rejects(_meta(), _report(id, uint8(Outcome.NO), OBSERVED), wrongState);
            Resolution memory r = _res(id);
            assertEq(uint8(r.proposed), uint8(Outcome.YES), "the first report stands");
            assertEq(r.evidenceHash, keccak256(first));
        }
        vm.revertToState(snap);
        {
            // test_state_replayAfterEscalation
            vm.warp(T + 300);
            assertTrue(ro.escalateToL2(id));
            _rejects(
                _meta(), _report(id), abi.encodeWithSelector(IResolutionOracle.WrongState.selector, RState.L2Pending)
            );
        }
        vm.revertToState(snap);
        {
            // test_state_replayAfterFinal
            _deliver(_meta(), _report(id));
            assertTrue(ro.assertProposal(id));
            mvenue.setResult(_res(id).assertionId, true);
            ro.finalizeMarket(id);
            assertEq(uint8(_state(id)), uint8(RState.Final));
            bytes memory wrongState = abi.encodeWithSelector(IResolutionOracle.WrongState.selector, RState.Final);
            _rejects(_meta(), _report(id), wrongState);
            _rejects(_meta(), _report(id, uint8(Outcome.NO), OBSERVED), wrongState);
            assertEq(engine.settleCalls(), 1);
        }
    }

    // ------------------------------------------------------------------ through the forwarder (V-C7, V-C8)

    /// Delivery through the header-faithful forwarder: metadata = rawReport[45:109], report =
    /// rawReport[109:]; a success ends the transmission, a revert leaves it retryable.
    function test_forwarder() public {
        uint256 snap = vm.snapshotState();
        {
            // test_forwarder_deliversThroughThe109ByteHeader
            bytes memory payload = _report(id);
            MockKeystoneForwarderLite.Header memory h = _header(keccak256("execution-1"));
            bytes memory raw = fwd.rawReport(h, payload);
            assertEq(raw.length, 109 + 256);
            assertEq(fwd.metadataOf(h).length, 64);
            vm.expectEmit(address(fwd));
            emit MockKeystoneForwarderLite.ReportProcessed(address(ro), h.executionId, h.reportId, true);
            assertTrue(fwd.report(address(ro), raw));
            assertEq(uint8(_state(id)), uint8(RState.Proposed));
            assertEq(_res(id).evidenceHash, keccak256(payload), "the hash of rawReport[109:]");
            bytes32 tid = fwd.transmissionId(address(ro), h.executionId, h.reportId);
            assertEq(uint8(fwd.transmissionState(tid)), uint8(MockKeystoneForwarderLite.TransmissionState.SUCCEEDED));
            vm.expectRevert(abi.encodeWithSelector(MockKeystoneForwarderLite.AlreadyAttempted.selector, tid));
            fwd.report(address(ro), raw);
        }
        vm.revertToState(snap);
        {
            // test_forwarder_revertedReportIsRetryable (the keeper halts market B late; the DON retries)
            MockKeystoneForwarderLite.Header memory h = _header(keccak256("execution-b"));
            bytes memory raw = fwd.rawReport(h, _report(idB));
            assertFalse(fwd.report(address(ro), raw), "pre-halt: onReport reverts");
            bytes32 tid = fwd.transmissionId(address(ro), h.executionId, h.reportId);
            assertEq(uint8(fwd.transmissionState(tid)), uint8(MockKeystoneForwarderLite.TransmissionState.FAILED));
            assertEq(uint8(_state(idB)), uint8(RState.None));
            ro.haltScheduled(idB); // pins the active production set
            assertTrue(fwd.report(address(ro), raw), "the same transmission succeeds on retry");
            assertEq(uint8(_state(idB)), uint8(RState.Proposed));
        }
        vm.revertToState(snap);
        {
            // test_forwarder_secondExecutionChangesNothing
            assertTrue(fwd.report(address(ro), fwd.rawReport(_header(keccak256("execution-1")), _report(id))));
            bytes memory later = _report(id, uint8(Outcome.NO), OBSERVED);
            assertFalse(fwd.report(address(ro), fwd.rawReport(_header(keccak256("execution-2")), later)));
            assertEq(uint8(_res(id).proposed), uint8(Outcome.YES));
        }
        vm.revertToState(snap);
        {
            // test_forwarder_invalidReceiver (a contract without IReceiver ends the transmission)
            MockKeystoneForwarderLite.Header memory h = _header(keccak256("execution-1"));
            bytes memory raw = fwd.rawReport(h, _report(id));
            assertFalse(fwd.report(address(reg), raw));
            bytes32 tid = fwd.transmissionId(address(reg), h.executionId, h.reportId);
            assertEq(
                uint8(fwd.transmissionState(tid)), uint8(MockKeystoneForwarderLite.TransmissionState.INVALID_RECEIVER)
            );
            vm.expectRevert(abi.encodeWithSelector(MockKeystoneForwarderLite.AlreadyAttempted.selector, tid));
            fwd.report(address(reg), raw);
        }
    }

    // ------------------------------------------------------------------ gas (§6.9)

    /// `onReport` alone stays under the 150k budget with every account and slot cold (plan §6.9, V-C13).
    function test_gas_underBudget() public {
        uint256 used = _coldReportGas(id, _report(id));
        emit log_named_uint("onReport gas (cold)", used);
        assertLt(used, 150_000);
    }

    /// The cost does not grow with the FeedSpec (a 400-byte URL path, 256-byte paths): `T + bufferSecs` is
    /// copied at listing, so `onReport` reads no FeedSpec string. Both markets are listed and halted the
    /// same way in this test, and both reports run with cold slots. The two differ by a few dozen gas,
    /// whichever runs first, from their different ids and hashes; reading the spec instead cost the long
    /// one about 60k more.
    function test_gas_independentOfFeedSpecSize() public {
        MarketInput memory s = _market();
        s.marketId = keccak256("market-short-spec");
        s.tau = OBSERVED + 600; // the minimum horizon from now
        MarketInput memory l = _market();
        l.marketId = keccak256("market-long-spec");
        l.tau = s.tau;
        l.feed.urlTemplate = string.concat("https://api.example-sports.com/", _repeat("p", 400), "/{id}");
        l.feed.finalPath = _longPath();
        l.feed.valuePath = _longPath();
        _list(s);
        _list(l);
        vm.warp(s.tau);
        ro.haltScheduled(s.marketId);
        ro.haltScheduled(l.marketId);
        uint64 observed = s.tau + 60;
        vm.warp(observed);
        uint256 shortSpec = _coldReportGas(s.marketId, _report(s.marketId, uint8(Outcome.YES), observed));
        bytes memory longReport = abi.encode(
            uint8(1), SELECTOR, address(ro), l.marketId, uint8(1), observed, VALUE_HASH, keccak256(abi.encode(l.feed))
        );
        assertApproxEqAbs(_coldReportGas(l.marketId, longReport), shortSpec, 500, "independent of the FeedSpec size");
    }

    /// Gas of the forwarder's call with the oracle's and registry's slots cold. The calldata is encoded
    /// before measuring, so the caller's memory expansion is not counted.
    function _coldReportGas(bytes32 market, bytes memory report) internal returns (uint256 used) {
        bytes memory data = abi.encodeCall(IReceiver.onReport, (_meta(), report));
        vm.cool(address(ro));
        vm.cool(address(reg));
        vm.prank(address(fwd));
        uint256 before = gasleft();
        (bool ok,) = address(ro).call(data);
        used = before - gasleft();
        assertTrue(ok, "onReport reverted");
        assertEq(uint8(_state(market)), uint8(RState.Proposed));
    }

    /// A 256-byte path of the §6.3 grammar: 9-byte segments joined by dots.
    function _longPath() internal pure returns (string memory) {
        bytes memory b = bytes(_repeat("a", 256));
        for (uint256 i = 9; i < 256; i += 10) {
            b[i] = ".";
        }
        return string(b);
    }

    function _repeat(bytes1 c, uint256 n) internal pure returns (string memory) {
        bytes memory b = new bytes(n);
        for (uint256 i; i < n; ++i) {
            b[i] = c;
        }
        return string(b);
    }

    // ------------------------------------------------------------------ helpers

    function _slice(bytes memory b, uint256 n) internal pure returns (bytes memory out) {
        out = new bytes(n);
        for (uint256 i; i < n; ++i) {
            out[i] = b[i];
        }
    }

    function _contains(string memory s, string memory needle) internal pure returns (bool) {
        bytes memory a = bytes(s);
        bytes memory b = bytes(needle);
        if (b.length > a.length) return false;
        for (uint256 i; i + b.length <= a.length; ++i) {
            bool eq = true;
            for (uint256 j; j < b.length; ++j) {
                if (a[i + j] != b[j]) {
                    eq = false;
                    break;
                }
            }
            if (eq) return true;
        }
        return false;
    }
}
