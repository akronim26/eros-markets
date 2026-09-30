// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {QMath} from "../../provisional/QMath.sol";
import {Q, WAD} from "../../provisional/MathTypes.sol";

/// @title LiquidationMath
/// @notice Liquidation predicates (spec §4.3, §5.2, DEC-13; reference/b/liquidation.py): allowed
///         reduction, eligibility, takeover authorization, x-free size estimate, fee-aware
///         bankruptcy tick, fee waiver, pair tick, pacing and continuation. Pure; orchestration
///         and every cash posting stay outside (B032 / Person A).
/// @dev Takeover authorization takes no work-budget or liquidity input, so a small caller budget
///      can never authorize confiscation of a positive-equity account.
library LiquidationMath {
    error BadUnits();
    error ZeroWorkBudget();

    uint256 internal constant FEE_Q_PER_LOT = Q; // 0.001 USDC per claim = one atom per lot

    enum Mode {
        NONE,
        REDUCE,
        TAKEOVER
    }

    enum Result {
        NOT_ELIGIBLE,
        DONE,
        NEEDS_MORE_WORK,
        TAKEOVER_AUTHORIZED,
        DISABLED
    }

    struct Snap {
        int256 xLots;
        int256 e0Q;
        int256 e1Q;
        int256 emQ; // mark equity after fees
        uint256 mmQ; // size-dependent MM at xLots
    }

    function _deficit(int256 e) private pure returns (uint256) {
        return e < 0 ? uint256(-e) : 0;
    }

    /// @notice |xA| < |xB|, no sign flip, both endpoint deficits nonincreasing, EA >= 0 and
    ///         EA - MMA >= min(EB - MMB, 0); only for an initially positive-equity account.
    function allowedReduction(Snap memory b, Snap memory a) internal pure returns (bool) {
        if (b.xLots == 0 || b.emQ <= 0) return false;
        if (QMath.abs(a.xLots) >= QMath.abs(b.xLots)) return false;
        if (a.xLots != 0 && (a.xLots > 0) != (b.xLots > 0)) return false;
        if (_deficit(a.e0Q) > _deficit(b.e0Q) || _deficit(a.e1Q) > _deficit(b.e1Q)) return false;
        if (a.emQ < 0) return false;
        int256 slackB = b.emQ - QMath.toInt(b.mmQ);
        return a.emQ - QMath.toInt(a.mmQ) >= (slackB < 0 ? slackB : int256(0));
    }

    /// @notice Price-free routes first; a stale mark alone never authorizes a mark liquidation.
    function eligibility(
        bool priceFresh,
        bool floorActive,
        bool graceExpired,
        int256 e0Q,
        int256 e1Q,
        int256 emQ,
        uint256 mmQ,
        uint256 imQ
    ) internal pure returns (Mode) {
        if (floorActive && (e0Q < 0 || e1Q < 0)) return Mode.TAKEOVER;
        if (e0Q <= 0 && e1Q <= 0 && (e0Q != 0 || e1Q != 0)) return Mode.TAKEOVER;
        if (!priceFresh) return Mode.NONE;
        if (emQ <= 0) return Mode.TAKEOVER;
        if (uint256(emQ) < mmQ) return Mode.REDUCE;
        if (graceExpired && uint256(emQ) < imQ) return Mode.REDUCE;
        return Mode.NONE;
    }

    /// @notice Only fresh E <= 0, a floor endpoint deficit, or both endpoints nonpositive.
    function authorizeTakeover(bool priceFresh, bool floorActive, int256 e0Q, int256 e1Q, int256 emQ)
        internal
        pure
        returns (bool)
    {
        if (floorActive && (e0Q < 0 || e1Q < 0)) return true;
        if (e0Q <= 0 && e1Q <= 0 && (e0Q != 0 || e1Q != 0)) return true;
        return priceFresh && emQ <= 0;
    }

    /// @notice Source estimate in lots without dividing by x:
    ///         g = IM - E, D = IM - s|x|, lots = ceil(2 g n / (D + sqrt(D^2 - 2 lambda g n^2)))
    ///         (all in Q; n = |x| lots). Invalid roots return a full close attempt. Estimate only.
    function sizeEstimateLots(uint256 imQ, int256 emQ, int256 xLots, uint256 sWad, uint256 lambdaWadPerClaim)
        internal
        pure
        returns (uint256 lots, bool fullClose)
    {
        uint256 n = QMath.abs(xLots);
        if (n == 0) return (0, false);
        if (emQ >= QMath.toInt(imQ)) return (n, true);
        uint256 g = emQ < 0 ? imQ + uint256(-emQ) : imQ - uint256(emQ);
        uint256 sx = n * 1000 * sWad;
        if (imQ <= sx) return (n, true);
        uint256 d = imQ - sx;
        uint256 d2 = d * d;
        uint256 sub = 2 * lambdaWadPerClaim * g * n * n;
        if (sub > d2) return (n, true);
        uint256 denom = d + QMath.sqrtDown(d2 - sub); // smaller root -> larger estimate
        lots = QMath.mulDivUp(2 * g, n, denom);
        if (lots > n) lots = n;
    }

    /// @notice Worst tick for closing `closeLots` with mark equity after fees >= threshold.
    ///         Long sells: t >= ceil(...); short buys: t <= floor(...).
    function bankruptcyTick(
        int256 xLots,
        uint256 closeLots,
        int256 cashQ,
        uint256 qWad,
        uint256 feeQ,
        int256 thresholdQ
    ) internal pure returns (uint16 tick, bool feasible) {
        uint256 absX = QMath.abs(xLots);
        if (closeLots == 0 || closeLots > absX || qWad > WAD) revert BadUnits();
        int256 mQ = int256(1000 * qWad);
        int256 n = int256(closeLots);
        int256 nq = n * int256(Q);
        if (xLots > 0) {
            int256 need = thresholdQ - cashQ + int256(feeQ) - (xLots - n) * mQ;
            int256 t = QMath.sDivCeil(need, nq);
            if (t > 999) return (0, false);
            return (uint16(uint256(t < 1 ? int256(1) : t)), true);
        }
        int256 have = cashQ - int256(feeQ) + (xLots + n) * mQ - thresholdQ;
        int256 tt = QMath.sDivFloor(have, nq);
        if (tt < 1) return (0, false);
        return (uint16(uint256(tt > 999 ? int256(999) : tt)), true);
    }

    /// @notice max(0, MM_after + min(E_before - MM_before, 0)).
    function thresholdQ(uint256 mmAfterQ, int256 emBeforeQ, uint256 mmBeforeQ)
        internal
        pure
        returns (int256)
    {
        int256 slack = emBeforeQ - QMath.toInt(mmBeforeQ);
        int256 t = QMath.toInt(mmAfterQ) + (slack < 0 ? slack : int256(0));
        return t > 0 ? t : int256(0);
    }

    /// @notice Largest fee <= one atom per lot keeping E >= threshold and both deficits
    ///         nonincreasing; the rest is waived (A posts only the charged amount).
    function feeAllowedQ(uint256 lots, Snap memory b, Snap memory afterNoFee, int256 thresholdQ_)
        internal
        pure
        returns (uint256)
    {
        int256 f = QMath.toInt(lots * FEE_Q_PER_LOT);
        int256 byEquity = afterNoFee.emQ - thresholdQ_;
        int256 byNo = afterNoFee.e0Q + int256(_deficit(b.e0Q));
        int256 byYes = afterNoFee.e1Q + int256(_deficit(b.e1Q));
        if (byEquity < f) f = byEquity;
        if (byNo < f) f = byNo;
        if (byYes < f) f = byYes;
        return f > 0 ? uint256(f) : 0;
    }

    /// @notice Common pair execution tick clamp(floor(q / 1e15), 1, 999).
    function pairTick(uint256 qWad) internal pure returns (uint16) {
        uint256 t = qWad / 1e15;
        if (t < 1) return 1;
        if (t > 999) return 999;
        return uint16(t);
    }

    /// @notice Per-block market liquidation-lot pacing. A missing measured cap disables ordinary
    ///         mark-based forced-book liquidation (spec §5.2).
    function pacing(
        uint256 requestedLots,
        uint256 maxExaminations,
        bool capConfigured,
        uint256 blockRemainingLots
    ) internal pure returns (uint256 allowedLots, bool disabled) {
        if (requestedLots == 0 || maxExaminations == 0) revert ZeroWorkBudget();
        if (!capConfigured) return (0, true);
        return (QMath.min(requestedLots, blockRemainingLots), false);
    }

    /// @notice Outcome after a bounded attempt. Positive equity that is not yet healthy and ran out
    ///         of work or liquidity is NEEDS_MORE_WORK, never a takeover.
    function continuation(bool healthyAfter, int256 xAfter, int256 emAfterQ) internal pure returns (Result) {
        if (xAfter == 0 || healthyAfter) return Result.DONE;
        if (emAfterQ > 0) return Result.NEEDS_MORE_WORK;
        return Result.TAKEOVER_AUTHORIZED; // fresh E <= 0 after the attempt: takeover branch
    }
}
