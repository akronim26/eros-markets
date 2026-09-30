// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {QMath} from "../../provisional/QMath.sol";
import {Q, RejectCode} from "../../provisional/MathTypes.sol";
import {MarginMath} from "./MarginMath.sol";

/// @title OrderAdmissionMath
/// @notice All-prefix order admission (spec §7.3, §7.5; reference/b/order_admission.py): adverse
///         marked-fill lower bound Emin, certified per-sign IM envelope over the reachable
///         inventory interval, and the bounded (<= 64 halvings) safe taker cap.
/// @dev Pure/view math. Endpoint deficits, the per-account deficit cap and market coverage are
///      Person A values; they enter as an explicit `CoverageInput` (or a coverage function for the
///      halving search). This library never computes reserve coverage itself.
library OrderAdmissionMath {
    error BadUnits();
    error ReservationUnderflow();

    uint16 internal constant NO_BID = 0;
    uint16 internal constant NO_ASK = 1000;
    uint256 internal constant MAX_HALVINGS = 64;

    struct OrderSums {
        uint128 bidLots; // Qb
        uint256 bidValueQ; // Vb = sum(lots * tick * Q)
        uint128 askLots; // Qa
        uint256 askValueQ; // Va
        uint256 feeCapQ;
        uint16 maxBidTick; // conservative upper bound; 0 if none
        uint16 minAskTick; // conservative lower bound; 1000 if none
    }

    struct CoverageInput {
        uint256 d0Q; // order-aware NO endpoint deficit incl. fee caps (A)
        uint256 d1Q; // order-aware YES endpoint deficit incl. fee caps (A)
        uint256 deficitCapQ; // 2% of reserveCapBaseQ (A)
        bool marketOk; // both R_y >= Dbar_y + B after replacing this account (A)
    }

    struct Account {
        int256 cashQ;
        int256 lots;
    }

    struct Pricing {
        uint256 qWad;
        uint256 secsToT;
        uint256 nowTs;
    }

    struct TakerRequest {
        uint256 requestedLots;
        bool isBid;
        uint16 limitTick;
        uint256 feeCapPerLotQ;
        uint256 minLots;
    }

    function emptySums() internal pure returns (OrderSums memory s) {
        s.minAskTick = NO_ASK;
    }

    function addOrder(OrderSums memory s, bool isBid, uint256 lots, uint16 tick, uint256 feeCapQ)
        internal
        pure
        returns (OrderSums memory)
    {
        if (tick < 1 || tick > 999 || lots == 0 || lots > type(uint64).max) revert BadUnits();
        if (isBid) {
            s.bidLots += uint128(lots);
            s.bidValueQ += lots * tick * Q;
            if (tick > s.maxBidTick) s.maxBidTick = tick;
        } else {
            s.askLots += uint128(lots);
            s.askValueQ += lots * tick * Q;
            if (tick < s.minAskTick) s.minAskTick = tick;
        }
        s.feeCapQ += feeCapQ;
        return s;
    }

    /// @notice Exact release by tick; extrema stay pessimistic. Any underflow or wrong-tick
    ///         attribution reverts (never saturates).
    function removeOrder(OrderSums memory s, bool isBid, uint256 lots, uint16 tick, uint256 feeCapQ)
        internal
        pure
        returns (OrderSums memory)
    {
        if (tick < 1 || tick > 999) revert BadUnits();
        uint256 v = lots * tick * Q;
        if (feeCapQ > s.feeCapQ) revert ReservationUnderflow();
        if (isBid) {
            if (lots > s.bidLots || v > s.bidValueQ) revert ReservationUnderflow();
            s.bidLots -= uint128(lots);
            s.bidValueQ -= v;
        } else {
            if (lots > s.askLots || v > s.askValueQ) revert ReservationUnderflow();
            s.askLots -= uint128(lots);
            s.askValueQ -= v;
        }
        s.feeCapQ -= feeCapQ;
        return s;
    }

    /// @notice Emin = c + x mQ - Qb max(PbidMax - mQ, 0) - Qa max(mQ - PaskMin, 0) - feeCap.
    function eMinQ(int256 cashQ, int256 lots, uint256 qWad, OrderSums memory s)
        internal
        pure
        returns (int256 e)
    {
        uint256 mQ = 1000 * qWad;
        e = MarginMath.markEquityQ(cashQ, lots, qWad);
        if (s.bidLots != 0) {
            uint256 pb = uint256(s.maxBidTick) * Q;
            if (pb > mQ) e -= QMath.toInt(uint256(s.bidLots) * (pb - mQ));
        }
        if (s.askLots != 0) {
            uint256 pa = uint256(s.minAskTick) * Q;
            if (mQ > pa) e -= QMath.toInt(uint256(s.askLots) * (mQ - pa));
        }
        e -= QMath.toInt(s.feeCapQ);
    }

    /// @notice Reachable inventory [x - Qa, x + Qb].
    function reach(int256 lots, OrderSums memory s) internal pure returns (int256 lo, int256 hi) {
        lo = lots - int256(uint256(s.askLots));
        hi = lots + int256(uint256(s.bidLots));
    }

    /// @notice max(LongIM(max(0, xHi)), ShortIM(max(0, -xLo))) using the certified monotone kernel.
    function imUpperQ(int256 lots, OrderSums memory s, Pricing memory pr, MarginMath.RiskParams memory p)
        internal
        pure
        returns (uint256 im, bool full)
    {
        (int256 lo, int256 hi) = reach(lots, s);
        uint256 longN = hi > 0 ? uint256(hi) : 0;
        uint256 shortN = lo < 0 ? uint256(-lo) : 0;
        if (longN != 0) {
            MarginMath.Margin memory ml = MarginMath.sideMargin(longN, true, pr.qWad, pr.secsToT, pr.nowTs, p);
            im = ml.imQ;
            full = ml.fullBacking;
        }
        if (shortN != 0) {
            MarginMath.Margin memory ms =
                MarginMath.sideMargin(shortN, false, pr.qWad, pr.secsToT, pr.nowTs, p);
            if (ms.imQ > im) im = ms.imQ;
            full = full || ms.fullBacking;
        }
    }

    /// @notice Decision for the account's full commitment set (resting sums plus any permit).
    function admit(
        Account memory a,
        OrderSums memory s,
        Pricing memory pr,
        MarginMath.RiskParams memory p,
        CoverageInput memory cov
    ) internal pure returns (bool ok, RejectCode reason) {
        if (pr.qWad == 0 || pr.qWad >= 1e18) return (false, RejectCode.INVALID_PRICE_OR_SIZE);
        if (!cov.marketOk) return (false, RejectCode.MARKET_COVERAGE);
        if (cov.d0Q > cov.deficitCapQ || cov.d1Q > cov.deficitCapQ) {
            return (false, RejectCode.ACCOUNT_DEFICIT_CAP);
        }
        (uint256 im, bool full) = imUpperQ(a.lots, s, pr, p);
        if (full) {
            // Exact full-backing predicate on A's order-aware endpoint deficits (assumption M-4).
            if (cov.d0Q == 0 && cov.d1Q == 0) return (true, RejectCode.NONE);
            return (false, RejectCode.TAKER_CAPACITY);
        }
        if (eMinQ(a.cashQ, a.lots, pr.qWad, s) >= QMath.toInt(im)) return (true, RejectCode.NONE);
        return (false, RejectCode.TAKER_CAPACITY);
    }

    /// @notice Reduce-only clip: side opposes the position and size <= |x|; never crosses zero.
    function reduceOnlyCap(int256 lots, bool isBid, uint256 requested) internal pure returns (uint256) {
        if (lots == 0 || (lots > 0) == isBid) return 0;
        uint256 absX = QMath.abs(lots);
        return requested < absX ? requested : absX;
    }

    /// @notice Bounded halving search: test the full request with the certified envelope, halve on
    ///         failure, at most 64 halvings. A returned cap has an all-prefix proof; maximality is
    ///         not promised. `coverageFn` returns A's coverage values for a trial commitment set.
    function safeTakerCap(
        TakerRequest memory req,
        Account memory a,
        OrderSums memory resting,
        Pricing memory pr,
        MarginMath.RiskParams memory p,
        function(Account memory, OrderSums memory) internal view returns (CoverageInput memory) coverageFn
    ) internal view returns (uint256 cap, uint256 steps, RejectCode reason) {
        cap = req.requestedLots;
        reason = RejectCode.BELOW_MIN_SIZE;
        while (cap != 0 && cap >= req.minLots) {
            bool ok;
            (ok, reason) = _tryCandidate(req, cap, a, resting, pr, p, coverageFn);
            if (ok) return (cap, steps, RejectCode.NONE);
            if (steps == MAX_HALVINGS) break;
            cap /= 2;
            ++steps;
        }
        if (reason == RejectCode.NONE) reason = RejectCode.BELOW_MIN_SIZE;
        return (0, steps, reason);
    }

    function _tryCandidate(
        TakerRequest memory req,
        uint256 cand,
        Account memory a,
        OrderSums memory resting,
        Pricing memory pr,
        MarginMath.RiskParams memory p,
        function(Account memory, OrderSums memory) internal view returns (CoverageInput memory) coverageFn
    ) private view returns (bool, RejectCode) {
        OrderSums memory trial =
            addOrder(_copy(resting), req.isBid, cand, req.limitTick, cand * req.feeCapPerLotQ);
        return admit(a, trial, pr, p, coverageFn(a, trial));
    }

    function _copy(OrderSums memory s) private pure returns (OrderSums memory c) {
        c = OrderSums(s.bidLots, s.bidValueQ, s.askLots, s.askValueQ, s.feeCapQ, s.maxBidTick, s.minAskTick);
    }
}
