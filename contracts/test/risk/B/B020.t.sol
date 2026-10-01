// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {RiskHarness, FormulaCoverage} from "../../harness/B/RiskHarness.sol";
import {MockAccountingPort} from "../../mocks/B/MockAccountingPort.sol";
import {MockBookAdapter} from "../../mocks/B/MockBookAdapter.sol";
import {IBookRiskHooks} from "../../../src/interfaces/IBookRiskHooks.sol";
import {MockResolutionAuthority} from "../../mocks/B/MockResolutionAuthority.sol";
import {IAccountingPort} from "../../../src/interfaces/IAccountingPort.sol";
import {IResolutionEngine, HaltView, SettlementView} from "../../../src/interfaces/IResolutionIngress.sol";
import {RiskContext} from "../../../src/pricing/RiskPricing.sol";
import {OrderAdmissionMath as OA} from "../../../src/math/OrderAdmissionMath.sol";
import {AccountingState, AdmissionMode, StepStatus, RejectCode} from "../../../src/math/RiskTypes.sol";
import {MathTypes} from "../../../src/math/MathTypes.sol";
import {ListingFixture} from "./B019.t.sol";
import {RiskFixture} from "../../math/B/B011.t.sol";

/// Exposes the accounting double's internal port for sequencing tests.
contract PortProbe is RiskHarness {
    function post(uint32 maker, uint32 taker, uint64 lots, uint16 tick) external {
        _acctPostFill(IAccountingPort.FillDelta(maker, taker, true, lots, tick, 0, 0));
    }

    function cov(uint32 t) external view returns (OA.CoverageInput memory) {
        return _acctCoverage(t, OA.emptySums(), 0, 0);
    }

    function freeze() external {
        _acctFreeze(100, 100);
    }

    function snap(uint256 n) external returns (IAccountingPort.JobProgress memory) {
        return _acctPrepareSnapshotChunk(n);
    }

    function pay(uint256 n) external returns (IAccountingPort.JobProgress memory) {
        return _acctPreparePayoutChunk(n, MathTypes.FinalOutcome.YES, 1e18);
    }

    function finish() external returns (IAccountingPort.FinishResult memory) {
        return _acctFinishPreparation();
    }
}

/// Mock book driven by scripted risk results: checks traversal and unrest discipline only.
contract ScriptedBook is MockBookAdapter {
    StepStatus[] public script;
    uint256 public cursor;
    uint256 public unrestCalls;
    uint256 public unrestLots;
    uint256 public finishCalls;

    function pushScript(StepStatus s) external {
        script.push(s);
    }

    function rest(uint32 owner, MathTypes.Side side, uint16 tick, uint64 lots, uint32 expiry)
        external
        returns (uint32)
    {
        return _mockRest(owner, side, tick, lots, expiry, false);
    }

    function place(OrderRequest memory req) external returns (PlaceResult memory) {
        return _mockPlace(req);
    }

    function _riskBeginAction() internal pure override returns (RiskSnapshot memory s) {
        s.marketOrderEpoch = 1;
    }

    function _riskTouchAccount(uint32, RiskSnapshot memory) internal pure override {}

    function _riskPrepareTaker(OrderRequest memory req, RiskSnapshot memory, AdmissionMode mode)
        internal
        pure
        override
        returns (TakerPermit memory p, RejectCode r)
    {
        p = TakerPermit(1, req.trader, req.side, req.limitTick, req.requestedLots, 0, 0, req.reduceOnly, mode);
        r = RejectCode.NONE;
    }

    function _riskTryMatchedFill(
        RiskSnapshot memory,
        TakerPermit memory permit,
        OrderView memory maker,
        uint64 proposed
    ) internal override returns (StepResult memory res) {
        StepStatus s = cursor < script.length ? script[cursor] : StepStatus.FILLED;
        cursor += 1;
        res.status = s;
        if (s == StepStatus.FILLED) {
            res.filledLots = proposed;
            res.makerRemainingLots = maker.remainingLots - proposed;
            permit.remainingLots -= proposed;
        }
    }

    function _riskAdmitRest(RiskSnapshot memory, uint32, MathTypes.Side, uint16, uint64, uint32, bool)
        internal
        pure
        override
        returns (EpochTag memory t, uint64, uint256)
    {
        t = EpochTag(1, 1);
    }

    function _riskConvertPermitToRest(RiskSnapshot memory, TakerPermit memory permit, uint64 lots, uint32)
        internal
        pure
        override
        returns (EpochTag memory t, uint64, uint256)
    {
        permit.remainingLots -= lots;
        t = EpochTag(1, 1);
    }

    function _riskOnUnrest(RiskSnapshot memory, uint32, EpochTag memory, MathTypes.Side, uint16, uint64 lots, uint256)
        internal
        override
    {
        unrestCalls += 1;
        unrestLots += lots;
    }

    function _riskCancelAll(uint32) internal pure override returns (EpochTag memory t) {
        t = EpochTag(1, 2);
    }

    function _riskFinishTaker(RiskSnapshot memory, TakerPermit memory) internal override {
        finishCalls += 1;
    }
}

/// Minimal scripted engine to exercise the resolution double's call mapping.
contract FakeEngine is IResolutionEngine {
    uint8 public lastY = type(uint8).max;
    uint256 public invalidCalls;
    uint256 public haltCalls;
    bool public failNext;

    function setFail(bool f) external {
        failNext = f;
    }

    function halt() external returns (HaltView memory v) {
        haltCalls += 1;
        v.halted = true;
    }

    function materializeScheduledHalt() external returns (HaltView memory v) {
        haltCalls += 1;
        v.halted = true;
    }

    function settle(uint8 y) external returns (bool) {
        require(!failNext, "engine revert");
        lastY = y;
        return true;
    }

    function settleInvalid() external returns (bool) {
        require(!failNext, "engine revert");
        invalidCalls += 1;
        return true;
    }

    function getHaltSnapshot() external view returns (HaltView memory) {}

    function getSettlementStatus() external view returns (SettlementView memory) {}
}

/// B020: counterpart and accounting doubles.
contract B020Test is Test {
    PortProbe h;

    function setUp() public {
        vm.warp(1000);
        h = new PortProbe();
        h.hInit(
            ListingFixture.make(1000, address(0xAC), address(0x30), address(0x60), address(0x51)),
            RiskFixture.profile(5, true)
        );
    }

    // ---------------------------------------------------------------- B modules without A state

    function test_riskModulesRunOnScriptedPort() public {
        h.hFeed(1000, 2000, 10, 6e17, 61e16, 63e16);
        vm.warp(2000);
        h.hEpochOpened();
        RiskContext memory c = h.riskContext();
        assertTrue(c.indexOk && c.markOk);
        assertEq(c.markWad, 62e16);
    }

    // ---------------------------------------------------------------- accounting double sequencing

    function test_touchBeforeBeginFails() public {
        h.mockSetAccount(1, 0, 0);
        vm.expectRevert(
            abi.encodeWithSelector(MockAccountingPort.MockSequence.selector, "touch before begin")
        );
        h.hTouch(1);
    }

    function test_postUntouchedFails() public {
        h.mockSetAccount(1, 0, 0);
        h.mockSetAccount(2, 0, 0);
        h.hBegin();
        h.hTouch(1);
        vm.expectRevert(
            abi.encodeWithSelector(
                MockAccountingPort.MockSequence.selector, "account not touched in this action"
            )
        );
        h.post(1, 2, 17, 613);
    }

    function test_postRecordsUnitsAndExactDeltas() public {
        h.mockSetAccount(1, 0, 0);
        h.mockSetAccount(2, 0, 0);
        h.hBegin();
        h.hTouch(1);
        h.hTouch(2);
        h.post(1, 2, 17, 613);
        assertEq(h.mockAccount(2).lots, 17);
        assertEq(h.mockAccount(2).cashQ, -10421e18);
        assertEq(h.mockAccount(1).cashQ, 10421e18);
        (MockAccountingPort.CallKind k, uint32 a, uint32 b, uint256 x,) = h.mockCalls(h.mockCallCount() - 1);
        assertEq(uint8(k), uint8(MockAccountingPort.CallKind.POST_FILL));
        assertEq(a, 1);
        assertEq(b, 2);
        assertEq(x, 17, "lots recorded");
    }

    function test_postDuringSweepFails() public {
        h.mockSetAccount(1, 0, 0);
        h.mockSetAccount(2, 0, 0);
        h.hBegin();
        h.hTouch(1);
        h.hTouch(2);
        h.mockSetState(AccountingState.ROLLOVER_SWEEP);
        vm.expectRevert(abi.encodeWithSelector(MockAccountingPort.MockSequence.selector, "post during sweep"));
        h.post(1, 2, 1, 500);
    }

    function test_unscriptedCoverageFails() public {
        h.mockSetAccount(1, 0, 0);
        vm.expectRevert(abi.encodeWithSelector(MockAccountingPort.MockUnscripted.selector, "coverage"));
        h.cov(1);
        FormulaCoverage fc = new FormulaCoverage(100_000e24, 2_000e24);
        h.mockSetCoverageScript(fc);
        assertTrue(h.cov(1).marketOk);
    }

    function test_settlementJobsInOrder() public {
        h.mockSetAccount(1, 0, 0);
        h.mockSetAccount(2, 0, 0);
        h.mockSetAccount(3, 0, 0);
        vm.expectRevert(
            abi.encodeWithSelector(MockAccountingPort.MockSequence.selector, "snapshot before freeze")
        );
        h.snap(2);
        h.freeze();
        vm.expectRevert(
            abi.encodeWithSelector(
                MockAccountingPort.MockSequence.selector, "payout before snapshot complete"
            )
        );
        h.pay(2);
        assertFalse(h.snap(2).done);
        assertTrue(h.snap(2).done);
        vm.expectRevert(
            abi.encodeWithSelector(MockAccountingPort.MockSequence.selector, "finish before payouts")
        );
        h.finish();
        h.pay(5);
        h.finish();
        vm.expectRevert(abi.encodeWithSelector(MockAccountingPort.MockSequence.selector, "frozen twice"));
        h.freeze();
    }

    // ---------------------------------------------------------------- mock book traversal

    function req(uint32 trader, uint16 limit, uint64 lots, uint16 steps)
        internal
        pure
        returns (IBookRiskHooks.OrderRequest memory r)
    {
        r.trader = trader;
        r.side = MathTypes.Side.BUY;
        r.limitTick = limit;
        r.requestedLots = lots;
        r.maxSteps = steps;
    }

    function test_dirtyQueueBoundedSteps() public {
        ScriptedBook b = new ScriptedBook();
        vm.roll(100);
        b.rest(5, MathTypes.Side.SELL, 500, 3, 99); // expired
        b.rest(7, MathTypes.Side.SELL, 500, 3, 0); // self
        b.rest(6, MathTypes.Side.SELL, 500, 3, 0); // pruned by risk
        b.rest(8, MathTypes.Side.SELL, 500, 3, 0); // pruned by risk
        b.rest(9, MathTypes.Side.SELL, 500, 3, 0); // would fill, never examined
        b.pushScript(StepStatus.PRUNE_MAKER);
        b.pushScript(StepStatus.PRUNE_MAKER);
        IBookRiskHooks.OrderRequest memory r = req(7, 500, 3, 4);
        r.kind = IBookRiskHooks.OrderKind.IOC;
        b.place(r);
        assertEq(b.lastExamined(), 4);
        assertEq(b.cursor(), 2, "fifth node never reached risk");
        (, bool live) = b.mockOrder(5);
        assertTrue(live);
    }

    function test_expiryBoundaryInclusive() public {
        ScriptedBook b = new ScriptedBook();
        vm.roll(50);
        b.rest(5, MathTypes.Side.SELL, 500, 3, 50);
        IBookRiskHooks.OrderRequest memory r = req(1, 500, 3, 4);
        r.kind = IBookRiskHooks.OrderKind.IOC;
        assertEq(b.place(r).filledLots, 3, "executable at K");
        b.rest(5, MathTypes.Side.SELL, 500, 3, 50);
        vm.roll(51);
        assertEq(b.place(r).filledLots, 0, "pruned at K+1");
    }

    function test_noUnrestOnFilledSize() public {
        ScriptedBook b = new ScriptedBook();
        b.rest(5, MathTypes.Side.SELL, 500, 10, 0);
        IBookRiskHooks.OrderRequest memory r = req(1, 500, 4, 4);
        r.kind = IBookRiskHooks.OrderKind.IOC;
        b.place(r);
        assertEq(b.unrestCalls(), 0, "filled lots are not unreserved again");
        (IBookRiskHooks.OrderView memory v,) = b.mockOrder(1);
        assertEq(v.remainingLots, 6);
    }

    function test_stopTakerKeepsMaker() public {
        ScriptedBook b = new ScriptedBook();
        b.rest(5, MathTypes.Side.SELL, 500, 2, 0);
        b.rest(6, MathTypes.Side.SELL, 500, 2, 0);
        b.pushScript(StepStatus.FILLED);
        b.pushScript(StepStatus.STOP_TAKER);
        IBookRiskHooks.OrderRequest memory r = req(1, 500, 4, 4);
        r.kind = IBookRiskHooks.OrderKind.IOC;
        assertEq(b.place(r).filledLots, 2);
        (, bool live) = b.mockOrder(2);
        assertTrue(live, "valid second maker remains");
        assertEq(b.finishCalls(), 1);
    }

    function test_crossedRemainderDropped() public {
        ScriptedBook b = new ScriptedBook();
        b.rest(5, MathTypes.Side.SELL, 500, 2, 0);
        b.rest(6, MathTypes.Side.SELL, 500, 2, 0);
        IBookRiskHooks.OrderRequest memory r = req(1, 500, 4, 1); // one step: second maker still crosses
        r.kind = IBookRiskHooks.OrderKind.LIMIT;
        MockBookAdapter.PlaceResult memory res = b.place(r);
        assertEq(res.filledLots, 2);
        assertEq(res.restedSlot, 0, "no crossed rest");
    }

    // ---------------------------------------------------------------- resolution double

    function test_resolutionDoubleMapping() public {
        FakeEngine e = new FakeEngine();
        MockResolutionAuthority m = new MockResolutionAuthority();
        m.bind(e);
        m.finalize(1);
        assertEq(e.lastY(), 1);
        m.finalize(2);
        assertEq(e.lastY(), 0);
        m.finalize(3);
        m.finalize(4);
        assertEq(e.invalidCalls(), 2);
        m.haltEarly();
        m.requestScheduledHalt();
        assertEq(e.haltCalls(), 2);
    }

    function test_delayedDeliveryRetries() public {
        FakeEngine e = new FakeEngine();
        MockResolutionAuthority m = new MockResolutionAuthority();
        m.bind(e);
        m.storeExternalFinality(1);
        e.setFail(true);
        assertFalse(m.retryDelivery());
        assertTrue(m.hasPending(), "failed delivery is not dropped");
        e.setFail(false);
        assertTrue(m.retryDelivery());
        assertFalse(m.hasPending());
        assertEq(e.lastY(), 1);
    }
}
