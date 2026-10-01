// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {RejectCode} from "../math/RiskTypes.sol";
import {LiquidationMath as LM} from "../math/LiquidationMath.sol";
import {MarginMath} from "../math/MarginMath.sol";
import {OrderAdmissionMath as OA} from "../math/OrderAdmissionMath.sol";
import {RiskContext} from "../pricing/RiskPricing.sol";
import {FloorLifecycle} from "./FloorLifecycle.sol";

/// @title LiquidationEligibility
/// @notice Liquidation modes from synchronized health and the single-partner pair reduction
///         (spec §5.2 step 1; B030). Eligibility is judged after Person A touched the account at
///         the legal cutoff; commitments are cancelled only once the account is eligible. A pair
///         closes min(requested, |xa|, |xb|) at the common tick clamp(floor(q/1e15), 1, 999) and
///         is posted once through A only if both accounts satisfy the fee-aware allowed-reduction
///         predicate and A's coverage checks; otherwise pairing is skipped with a reason.
/// @dev A stale mark alone never authorizes a mark liquidation (price-free routes excepted).
abstract contract LiquidationEligibility is FloorLifecycle {
    uint8 internal constant PRED_FRESH_NONPOSITIVE = 1;
    uint8 internal constant PRED_FLOOR_DEFICIT = 2;
    uint8 internal constant PRED_BOTH_ENDPOINTS = 3;

    struct Eligibility {
        LM.Mode mode;
        uint8 takeoverPredicate;
        bool priceFresh;
        bool graceExpired;
        int256 e0Q;
        int256 e1Q;
        int256 emQ;
        uint256 mmQ;
        uint256 imQ;
    }

    struct PairResult {
        bool executed;
        RejectCode reason;
        uint64 lots;
        uint16 tick;
        uint256 feeTargetQ;
        uint256 feePartnerQ;
    }

    event PairReduction(
        uint32 indexed target,
        uint32 indexed partner,
        uint64 lots,
        uint16 tick,
        uint256 feeTargetQ,
        uint256 feePartnerQ
    );
    event PairSkipped(uint32 indexed target, uint32 indexed partner, RejectCode reason);

    /// @notice Eligibility of an already-touched account at the frozen action context.
    function _eligibility(uint32 trader, RiskContext memory c)
        internal
        view
        returns (Eligibility memory el)
    {
        AccountView memory a = _acctAccount(trader);
        (el.e0Q, el.e1Q) = MarginMath.endpoints(a.cashQ, a.lots);
        el.priceFresh = _markLiquidationAllowed(c);
        bool belowMm;
        if (el.priceFresh && a.lots != 0) {
            (, MarginMath.Health memory h) = _health(trader, c);
            (el.emQ, el.mmQ, el.imQ) = (h.markEquityQ, h.mmQ, h.imQ);
            belowMm = h.status == MarginMath.Status.BELOW_MM || h.status == MarginMath.Status.NONPOSITIVE;
        } else if (el.priceFresh) {
            el.emQ = a.cashQ;
        }
        el.graceExpired = _graceExpired(trader, c, belowMm);
        el.mode = LM.eligibility(
            el.priceFresh, c.legacyTakeoverWindow, el.graceExpired, el.e0Q, el.e1Q, el.emQ, el.mmQ, el.imQ
        );
        if (el.mode == LM.Mode.TAKEOVER) {
            if (c.legacyTakeoverWindow && (el.e0Q < 0 || el.e1Q < 0)) {
                el.takeoverPredicate = PRED_FLOOR_DEFICIT;
            } else if (el.e0Q <= 0 && el.e1Q <= 0) {
                el.takeoverPredicate = PRED_BOTH_ENDPOINTS;
            } else {
                el.takeoverPredicate = PRED_FRESH_NONPOSITIVE;
            }
        }
        if (a.lots == 0 && el.mode == LM.Mode.REDUCE) el.mode = LM.Mode.NONE; // nothing to reduce
    }

    function _snapAt(int256 cashQ, int256 lots, RiskContext memory c)
        internal
        view
        returns (LM.Snap memory s)
    {
        (s.e0Q, s.e1Q) = MarginMath.endpoints(cashQ, lots);
        s.emQ = MarginMath.markEquityQ(cashQ, lots, c.markWad);
        s.xLots = lots;
        if (lots != 0) {
            s.mmQ = MarginMath.sideMargin(
                _absLots(lots),
                lots > 0,
                c.markWad,
                c.secsToT,
                c.economicTime,
                _effectiveParams(c.economicTime)
            ).mmQ;
        }
    }

    struct Leg {
        LM.Snap before;
        LM.Snap afterFee;
        uint256 fee;
        int256 dCash;
        int256 dLots;
    }

    /// @notice Post-reduction state of one side of a pair (or a book close) incl. the waived fee.
    function _reduced(int256 cashQ, int256 lots, uint64 n, uint16 tick, RiskContext memory c)
        internal
        view
        returns (Leg memory g)
    {
        g.before = _snapAt(cashQ, lots, c);
        g.dLots = lots > 0 ? -int256(uint256(n)) : int256(uint256(n));
        int256 notional = int256(uint256(n) * tick * 1e18);
        int256 cashNoFee = cashQ + (lots > 0 ? notional : -notional);
        LM.Snap memory noFee = _snapAt(cashNoFee, lots + g.dLots, c);
        g.fee = LM.feeAllowedQ(n, g.before, noFee, LM.thresholdQ(noFee.mmQ, g.before.emQ, g.before.mmQ));
        g.afterFee = _snapAt(cashNoFee - int256(g.fee), lots + g.dLots, c);
        g.dCash = cashNoFee - int256(g.fee) - cashQ;
    }

    /// @notice One explicitly supplied opposite partner; both rechecked; posted once or skipped.
    function _pairReduce(uint32 target, uint32 partner, uint64 maxLots, RiskContext memory c, address keeper)
        internal
        returns (PairResult memory r)
    {
        r.tick = LM.pairTick(c.markWad);
        if (partner == 0 || partner == target || !_markLiquidationAllowed(c)) {
            return _skip(target, partner, r, RejectCode.BAD_STAGE);
        }
        _touch(partner);
        AccountView memory ta = _acctAccount(target);
        AccountView memory pa = _acctAccount(partner);
        if (ta.lots == 0 || pa.lots == 0 || (ta.lots > 0) == (pa.lots > 0)) {
            return _skip(target, partner, r, RejectCode.NO_REDUCIBLE_POSITION);
        }
        if (_eligibility(partner, c).mode != LM.Mode.REDUCE) {
            return _skip(target, partner, r, RejectCode.MAKER_BELOW_MM);
        }
        uint64 n = maxLots;
        if (_absLots(ta.lots) < n) n = uint64(_absLots(ta.lots));
        if (_absLots(pa.lots) < n) n = uint64(_absLots(pa.lots));
        if (n == 0) return _skip(target, partner, r, RejectCode.BELOW_MIN_SIZE);
        if (!_pairChecks(ta, pa, target, partner, n, r, c)) {
            return _skip(target, partner, r, RejectCode.TAKER_CAPACITY);
        }
        _resCancelAll(partner);
        // The target is the taker: it sells when long and buys when short.
        _acctPostLiquidationFill(
            FillDelta(partner, target, ta.lots < 0, n, r.tick, r.feePartnerQ, r.feeTargetQ),
            r.feeTargetQ + r.feePartnerQ,
            keeper
        );
        r.executed = true;
        r.lots = n;
        emit PairReduction(target, partner, n, r.tick, r.feeTargetQ, r.feePartnerQ);
    }

    function _pairChecks(
        AccountView memory ta,
        AccountView memory pa,
        uint32 target,
        uint32 partner,
        uint64 n,
        PairResult memory r,
        RiskContext memory c
    ) internal view returns (bool) {
        Leg memory t = _reduced(ta.cashQ, ta.lots, n, r.tick, c);
        Leg memory p = _reduced(pa.cashQ, pa.lots, n, r.tick, c);
        (r.feeTargetQ, r.feePartnerQ) = (t.fee, p.fee);
        if (!LM.allowedReduction(t.before, t.afterFee) || !LM.allowedReduction(p.before, p.afterFee)) {
            return false;
        }
        OA.OrderSums memory none = OA.emptySums();
        return _acctCoverage(target, none, t.dCash, t.dLots).marketOk
            && _acctCoverage(partner, none, p.dCash, p.dLots).marketOk;
    }

    function _skip(uint32 target, uint32 partner, PairResult memory r, RejectCode why)
        internal
        returns (PairResult memory)
    {
        r.reason = why;
        emit PairSkipped(target, partner, why);
        return r;
    }
}
