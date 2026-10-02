// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;
import {QMath as Q} from "./QMath.sol";

library PremiumMath {
    uint256 private constant CHARGE_DENOMINATOR = 172800e36;

    struct Segment {
        int256 principalCashQ;
        int128 lots;
        int256 rateQPerLotSec;
        uint64 start;
        uint64 fundingStop;
        uint64 surchargeUntil;
    }

    struct Tariff {
        uint256 hazard0WadPerDay;
        uint256 hazard1WadPerDay;
        uint256 loadWad;
    }

    struct Charge {
        uint256 whole;
        uint256 remainder;
        uint256 slopeScale;
    }

    error Domain();

    /// @dev Ceil of the analytic positive-part area, within one Q-second of exact.
    function positiveIntegralUp(int256 a, int256 b, uint64 dt) internal pure returns (uint256) {
        if (Q.abs(a) >= 1 << 182 || Q.abs(b) > 1 << 128 || dt > 3600) revert Domain();
        int256 end = a + b * int256(uint256(dt));
        if (a >= 0 && end >= 0) return Q.mulDivUp(uint256(a + end), dt, 2);
        if (a <= 0 && end <= 0) return 0;
        if (a < 0) return Q.mulDivUp(uint256(end), uint256(end), 2 * Q.abs(b));
        return Q.mulDivUp(uint256(a), uint256(a), 2 * Q.abs(b));
    }

    /// @notice Cumulative from genuine segment origin. Neutral touches never change it.
    /// @dev Exact rational charges share one denominator and are rounded upward once.
    function cumulative(Segment memory s, Tariff memory t, uint64 until)
        internal
        pure
        returns (uint256 total)
    {
        if (
            until < s.start || until - s.start > 3600 || Q.abs(s.rateQPerLotSec) > 1e18
                || t.hazard0WadPerDay > 1e18 || t.hazard1WadPerDay > 1e18 || t.loadWad > 1e18
        ) revert Domain();
        Q.cash(s.principalCashQ);
        Q.position(s.lots);
        Charge memory charge = Charge(0, 0, Q.max(Q.abs(int256(s.lots) * s.rateQPerLotSec), 1));
        uint64 left = s.start;
        while (left < until) {
            uint64 right = until;
            if (s.fundingStop > left && s.fundingStop < right) right = s.fundingStop;
            if (s.surchargeUntil > left && s.surchargeUntil < right) right = s.surchargeUntil;
            uint64 funded = uint64(Q.min(left, s.fundingStop));
            int256 cash = s.principalCashQ;
            if (funded > s.start) {
                cash -= int256(s.lots) * s.rateQPerLotSec * int256(uint256(funded - s.start));
            }
            int256 slope = left < s.fundingStop ? int256(s.lots) * s.rateQPerLotSec : int256(0);
            uint256 load = (1e18 + t.loadWad) * (left < s.surchargeUntil ? 4 : 1);
            _accumulate(charge, -cash, slope, right - left, t.hazard0WadPerDay * load);
            _accumulate(
                charge, -cash - int256(s.lots) * 1000e18, slope, right - left, t.hazard1WadPerDay * load
            );
            left = right;
        }
        uint256 denominator = CHARGE_DENOMINATOR * charge.slopeScale;
        total = charge.whole + charge.remainder / denominator;
        if (charge.remainder % denominator != 0) ++total;
    }

    function _accumulate(
        Charge memory charge,
        int256 intercept,
        int256 slope,
        uint64 duration,
        uint256 coefficient
    ) private pure {
        int256 endpoint = intercept + slope * int256(uint256(duration));
        uint256 numerator;
        uint256 denominator = CHARGE_DENOMINATOR;
        uint256 remainderScale = charge.slopeScale;
        if (intercept >= 0 && endpoint >= 0) {
            numerator = uint256(intercept + endpoint) * duration;
        } else if (intercept <= 0 && endpoint <= 0) {
            return;
        } else {
            uint256 positiveEndpoint = uint256(intercept > 0 ? intercept : endpoint);
            numerator = positiveEndpoint * positiveEndpoint;
            denominator *= charge.slopeScale;
            remainderScale = 1;
        }
        charge.whole += Q.mulDiv(numerator, coefficient, denominator);
        charge.remainder += mulmod(numerator, coefficient, denominator) * remainderScale;
    }
}
