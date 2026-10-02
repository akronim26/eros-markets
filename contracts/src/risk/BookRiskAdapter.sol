// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {AccountingState, AdmissionMode, StepStatus, RejectCode} from "../math/RiskTypes.sol";
import {MathTypes} from "../math/MathTypes.sol";
import {IBookRiskHooks} from "../interfaces/IBookRiskHooks.sol";
import {OrderAdmissionMath as OA} from "../math/OrderAdmissionMath.sol";
import {RiskContext} from "../pricing/RiskPricing.sol";
import {OrderAdmission} from "./OrderAdmission.sol";

/// @title BookRiskAdapter
/// @notice The spec §7.5 hook set implemented over Person A's accounting port (B024). One frozen
///         RiskContext per action; every maker is touched and re-admitted before its fill; each
///         paired fill is preflighted, posted once through A, and followed by a coverage recheck
///         of both accounts. Expected skips are return codes before mutation; any unexpected
///         failure reverts the whole transaction (all earlier fills and logs included).
/// @dev All calls are internal: no token transfer, external call or callback in the loop. The
///      book caps examined makers at 64 (checked here too). Filled lots are unreserved inside the
///      fill, so the book must not call `_riskOnUnrest` for them.
abstract contract BookRiskAdapter is OrderAdmission, IBookRiskHooks {
    error ForcedReductionNotUserSelectable();
    error TooManySteps();
    error SnapshotMismatch();
    error RestRejected(RejectCode reason);
    error UnexpectedCoverageFailure(uint32 account);
    error BadProposal();

    uint16 internal constant MAX_EXAMINED = 64;

    RiskContext internal _actionCtx;
    uint64 internal _actionId;
    uint64 internal _permitSeq;
    mapping(uint32 trader => uint64 actionId) internal _touchedIn;

    event MakerPruned(uint32 indexed maker, uint32 slot, RejectCode reason);

    /// @dev Actual trading fee for a fill; zero in the initial profile (A FeeMath at merge, S-8).
    function _tradeFeeQ(uint64, uint16, bool) internal view virtual returns (uint256) {
        return 0;
    }

    // ------------------------------------------------------------------ action / touch

    function _riskBeginAction() internal virtual override returns (RiskSnapshot memory s) {
        AccrualView memory av = _acctBeginAction();
        RiskContext memory c = _pricingContext();
        _actionCtx = c;
        _actionId += 1;
        s.marketOrderEpoch = av.marketOrderEpoch;
        s.riskVersion = c.riskVersion;
        s.economicTime = c.economicTime;
        s.stage = c.stage;
        s.indexWad = c.indexWad;
        s.markWad = c.markWad;
        s.fundingIndex = av.fundingIndex;
        s.accountingEpochId = av.accountingEpochId;
        s.premiumCutoff = av.cutoff;
        s.premiumTariffHash = av.premiumTariffHash;
        s.parameterVersion = c.riskVersion;
    }

    function _riskTouchAccount(uint32 trader, RiskSnapshot memory) internal virtual override {
        _touch(trader);
    }

    function _touch(uint32 trader) internal {
        if (_touchedIn[trader] == _actionId) return; // same-cutoff repeat is a no-op
        _touchedIn[trader] = _actionId;
        _acctTouch(trader);
        _resSyncEpoch(trader);
        _afterTouch(trader);
    }

    /// @dev Lifecycle hook after A settled the account at the action cutoff (B028 grace state).
    function _afterTouch(uint32 trader) internal virtual {}

    function _checkSnap(RiskSnapshot memory s) internal view {
        if (s.marketOrderEpoch != _acctMarketOrderEpoch() || s.riskVersion != _actionCtx.riskVersion) {
            revert SnapshotMismatch();
        }
    }

    // ------------------------------------------------------------------ taker

    function _riskPrepareTaker(OrderRequest memory req, RiskSnapshot memory snap, AdmissionMode mode)
        internal
        virtual
        override
        returns (TakerPermit memory p, RejectCode rejection)
    {
        if (req.maxSteps > MAX_EXAMINED) revert TooManySteps();
        if (mode == AdmissionMode.FORCED_REDUCTION) {
            if (!_forcedReductionAuthorized()) revert ForcedReductionNotUserSelectable();
            return _forcedPermit(req, snap);
        }
        _checkSnap(snap);
        _touch(req.trader);
        TakerDecision memory d = _takerDecision(
            _actionCtx,
            TakerInput(
                req.trader, req.side == MathTypes.Side.BUY, req.limitTick, req.requestedLots, req.reduceOnly
            )
        );
        p.localPermitId = ++_permitSeq;
        p.trader = req.trader;
        p.side = req.side;
        p.limitTick = req.limitTick;
        p.reduceOnly = req.reduceOnly;
        p.reduceVersion = d.reduceVersion;
        p.mode = req.reduceOnly ? AdmissionMode.VOLUNTARY_REDUCTION : AdmissionMode.NORMAL;
        if (d.capLots == 0) return (p, d.reason);
        p.remainingLots = d.capLots;
        p.remainingFeeCapQ = d.feeCapQ;
        _permitReserve(req.trader, req.side == MathTypes.Side.BUY, req.limitTick, d.capLots, d.feeCapQ);
        return (p, RejectCode.NONE);
    }

    // ------------------------------------------------------------------ forced reduction (B031)

    /// @dev Only the liquidation module can grant FORCED_REDUCTION, and only inside its own call.
    function _forcedReductionAuthorized() internal view virtual returns (bool) {
        return false;
    }

    /// @dev Fee and allowed-reduction check for one forced (liquidation) fill; default refuses.
    function _forcedFillFee(TakerPermit memory, OrderView memory, uint64)
        internal
        view
        virtual
        returns (bool ok, uint256 feeQ)
    {
        return (false, 0);
    }

    /// @dev Posting route: ordinary fills via `_acctPostFill`; liquidation overrides for forced fills.
    function _postFillDelta(FillDelta memory d, bool) internal virtual returns (uint256) {
        _acctPostFill(d);
        return d.takerFeeQ;
    }

    /// @notice Reduce-only permit for a liquidation IOC: clipped to |x|, opposite side, no IM test
    ///         (each fill is checked against the allowed-reduction predicate instead).
    function _forcedPermit(OrderRequest memory req, RiskSnapshot memory snap)
        internal
        returns (TakerPermit memory p, RejectCode rejection)
    {
        _checkSnap(snap);
        _touch(req.trader);
        p.localPermitId = ++_permitSeq;
        p.trader = req.trader;
        p.side = req.side;
        p.limitTick = req.limitTick;
        p.reduceOnly = true;
        p.mode = AdmissionMode.FORCED_REDUCTION;
        if (_actionCtx.halted) return (p, RejectCode.HALTED);
        if (_acctAccountingState() != AccountingState.READY) return (p, RejectCode.BAD_STAGE);
        AccountView memory a = _acctAccount(req.trader);
        p.reduceVersion = a.positionVersion;
        uint64 cap = uint64(OA.reduceOnlyCap(a.lots, req.side == MathTypes.Side.BUY, req.requestedLots));
        if (cap == 0) return (p, RejectCode.NO_REDUCIBLE_POSITION);
        p.remainingLots = cap;
        _permitReserve(req.trader, req.side == MathTypes.Side.BUY, req.limitTick, cap, 0);
        return (p, RejectCode.NONE);
    }

    // ------------------------------------------------------------------ fill

    function _riskTryMatchedFill(
        RiskSnapshot memory snap,
        TakerPermit memory permit,
        OrderView memory maker,
        uint64 proposedLots
    ) internal virtual override returns (StepResult memory r) {
        _checkSnap(snap);
        if (proposedLots == 0 || proposedLots > maker.remainingLots || proposedLots > permit.remainingLots) {
            revert BadProposal();
        }
        _touch(maker.owner);
        MakerDecision memory md = _makerDecision(
            _actionCtx,
            MakerInput(
                maker.owner,
                maker.side == MathTypes.Side.BUY,
                maker.admittedAt.marketOrderEpoch,
                maker.admittedAt.accountOrderEpoch,
                maker.reduceOnly,
                maker.reduceVersion,
                proposedLots
            )
        );
        if (md.prune) return _prune(maker, md.cancelAll, md.reason);
        uint64 lots = md.allowedLots;
        if (permit.reduceOnly) {
            AccountView memory ta = _acctAccount(permit.trader);
            if (ta.positionVersion != permit.reduceVersion) return _stop(RejectCode.NO_REDUCIBLE_POSITION);
            uint64 clip = uint64(OA.reduceOnlyCap(ta.lots, permit.side == MathTypes.Side.BUY, lots));
            if (clip == 0) return _stop(RejectCode.NO_REDUCIBLE_POSITION);
            lots = clip;
        }
        FillPlan memory f = _plan(permit, maker, lots);
        if (permit.mode == AdmissionMode.FORCED_REDUCTION) {
            (bool ok, uint256 fee) = _forcedFillFee(permit, maker, lots);
            if (!ok) return _stop(RejectCode.TAKER_CAPACITY);
            f.takerFeeQ = fee;
        }
        if (
            maker.reduceOnly
                && !_voluntaryReductionAllowed(
                    f.maker, !f.takerBuys, f.lots, f.makerTick, f.makerFeeQ, _actionCtx
                )
        ) return _prune(maker, false, RejectCode.MAKER_BELOW_MM);
        if (
            permit.mode == AdmissionMode.VOLUNTARY_REDUCTION
                && !_voluntaryReductionAllowed(
                    f.taker, f.takerBuys, f.lots, f.makerTick, f.takerFeeQ, _actionCtx
                )
        ) return _stop(RejectCode.TAKER_CAPACITY);
        (bool takerCapOk, bool makerCapOk, bool marketOk) = _preflight(f, permit.reduceOnly, maker.reduceOnly);
        if (!makerCapOk) return _prune(maker, true, RejectCode.ACCOUNT_DEFICIT_CAP);
        if (!takerCapOk) return _stop(RejectCode.TAKER_CAPACITY);
        if (!marketOk) return _stop(RejectCode.MARKET_COVERAGE); // conservative stop, maker kept
        _commitFill(f, permit, maker);
        r.status = StepStatus.FILLED;
        r.filledLots = lots;
        r.notionalQ = uint256(lots) * maker.tick * 1e18;
        r.makerFeeQ = f.makerFeeQ;
        r.takerFeeQ = f.takerFeeQ;
        r.makerRemainingLots = maker.remainingLots - lots;
        r.removeMakerRemainder = md.removeRemainder && r.makerRemainingLots != 0;
    }

    function _plan(TakerPermit memory permit, OrderView memory maker, uint64 lots)
        internal
        view
        returns (FillPlan memory f)
    {
        f.taker = permit.trader;
        f.maker = maker.owner;
        f.takerBuys = permit.side == MathTypes.Side.BUY;
        f.makerTick = maker.tick;
        f.lots = lots;
        f.permitTick = permit.limitTick;
        f.takerFeeQ = _tradeFeeQ(lots, maker.tick, false);
        f.makerFeeQ = _tradeFeeQ(lots, maker.tick, true);
        // Fee caps are consumed pro rata to the filled share (assumption M-11).
        f.takerPermitFeeUsedQ = permit.remainingFeeCapQ - permit.remainingFeeCapQ
            * (permit.remainingLots - lots) / permit.remainingLots;
        f.makerFeeCapUsedQ = maker.remainingFeeCapQ - maker.remainingFeeCapQ * (maker.remainingLots - lots)
            / maker.remainingLots;
    }

    /// @dev Reservations are consumed first, so Person A's paired posting (A026 `_pairedFill`)
    ///      receives the exact post-fill order aggregates of both accounts and its own coverage
    ///      assertion sees the true post-fill state (interface-reconciliation R-05).
    function _commitFill(FillPlan memory f, TakerPermit memory permit, OrderView memory maker) internal {
        _resConsumeFill(f.maker, maker.side == MathTypes.Side.BUY, maker.tick, f.lots, f.makerFeeCapUsedQ);
        _permitConsume(f.taker, f.takerBuys, permit.limitTick, f.lots, f.takerPermitFeeUsedQ);
        _acctReplaceContribution(f.taker, _combined(f.taker));
        f.takerFeeQ = _postFillDelta(
            FillDelta(f.maker, f.taker, f.takerBuys, f.lots, f.makerTick, f.makerFeeQ, f.takerFeeQ),
            permit.mode == AdmissionMode.FORCED_REDUCTION
        );
        permit.remainingLots -= f.lots;
        permit.remainingFeeCapQ -= f.takerPermitFeeUsedQ;
        _recheck(f.taker, _combined(f.taker));
        _recheck(f.maker, _resSums(f.maker));
    }

    /// @dev Post-fill recheck with updated mutable aggregates; failure after a proven preflight is
    ///      an implementation defect and reverts the whole transaction.
    function _recheck(uint32 account, OA.OrderSums memory sums) internal view {
        if (!_acctCoverage(account, sums, 0, 0).marketOk) revert UnexpectedCoverageFailure(account);
    }

    function _prune(OrderView memory maker, bool cancelAll, RejectCode reason)
        internal
        returns (StepResult memory r)
    {
        if (cancelAll) _resCancelAll(maker.owner);
        emit MakerPruned(maker.owner, maker.key.slot, reason);
        r.status = StepStatus.PRUNE_MAKER;
        r.reason = reason;
        r.makerRemainingLots = maker.remainingLots;
    }

    function _stop(RejectCode reason) internal pure returns (StepResult memory r) {
        r.status = StepStatus.STOP_TAKER;
        r.reason = reason;
    }

    // ------------------------------------------------------------------ rests / unrest

    function _riskAdmitRest(
        RiskSnapshot memory snap,
        uint32 owner,
        MathTypes.Side side,
        uint16 tick,
        uint64 lots,
        uint32,
        bool reduceOnly
    ) internal virtual override returns (EpochTag memory tag, uint64 reduceVersion, uint256 feeCapQ) {
        _checkSnap(snap);
        _touch(owner);
        TakerDecision memory d =
            _takerDecision(_actionCtx, TakerInput(owner, side == MathTypes.Side.BUY, tick, lots, reduceOnly));
        if (d.capLots != lots) {
            revert RestRejected(d.reason == RejectCode.NONE ? RejectCode.TAKER_CAPACITY : d.reason);
        }
        (tag.marketOrderEpoch, tag.accountOrderEpoch) =
            _resAdd(owner, side == MathTypes.Side.BUY, tick, lots, d.feeCapQ);
        return (tag, d.reduceVersion, d.feeCapQ);
    }

    /// @notice A LIMIT remainder converts the existing permit; it is not reserved twice.
    function _riskConvertPermitToRest(
        RiskSnapshot memory snap,
        TakerPermit memory permit,
        uint64 lotsToRest,
        uint32
    ) internal virtual override returns (EpochTag memory tag, uint64 reduceVersion, uint256 feeCapQ) {
        _checkSnap(snap);
        if (lotsToRest == 0 || lotsToRest > permit.remainingLots) {
            revert RestRejected(RejectCode.INVALID_PRICE_OR_SIZE);
        }
        feeCapQ = permit.remainingFeeCapQ * lotsToRest / permit.remainingLots;
        bool isBid = permit.side == MathTypes.Side.BUY;
        _permitConsume(permit.trader, isBid, permit.limitTick, lotsToRest, feeCapQ);
        (tag.marketOrderEpoch, tag.accountOrderEpoch) =
            _resAdd(permit.trader, isBid, permit.limitTick, lotsToRest, feeCapQ);
        permit.remainingLots -= lotsToRest;
        permit.remainingFeeCapQ -= feeCapQ;
        _acctReplaceContribution(permit.trader, _combined(permit.trader));
        return (tag, permit.reduceVersion, feeCapQ);
    }

    function _riskOnUnrest(
        RiskSnapshot memory,
        uint32 owner,
        EpochTag memory admittedAt,
        MathTypes.Side side,
        uint16 tick,
        uint64 removedLots,
        uint256 releasedFeeCapQ
    ) internal virtual override {
        _touch(owner);
        _resRemove(
            owner,
            admittedAt.marketOrderEpoch,
            admittedAt.accountOrderEpoch,
            side == MathTypes.Side.BUY,
            tick,
            removedLots,
            releasedFeeCapQ
        );
    }

    function _riskCancelAll(uint32 trader) internal virtual override returns (EpochTag memory t) {
        _touch(trader);
        (t.marketOrderEpoch, t.accountOrderEpoch) = _resCancelAll(trader);
    }

    function _riskFinishTaker(RiskSnapshot memory, TakerPermit memory permit) internal virtual override {
        if (permit.trader == 0) return;
        _permitRelease(permit.trader);
        permit.remainingLots = 0;
        permit.remainingFeeCapQ = 0;
        _recheck(permit.trader, _resSums(permit.trader));
    }

    function accountingReady() public view returns (bool) {
        return _acctAccountingState() == AccountingState.READY;
    }
}
