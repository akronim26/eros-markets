// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {QMath} from "./QMath.sol";
import {WAD} from "./RiskTypes.sol";

/// @title PricingMath
/// @notice Validity-weighted time integrals, TWAP windows, impact-mid depth validity, basis, mark
///         median and band clamp, beta0 funding rate and the movement trigger (spec §4.1, §4.4;
///         reference/b/pricing.py). No signatures, no storage, no feeds. Window selection reads
///         the chain ID; the pricing arithmetic remains pure.
/// @dev Prices are wad (basis may be negative, so samples are int256). A sample observed at t
///      carries forward over [t, min(next.t, t + stale)); a later sample at the same second
///      replaces the earlier one with zero elapsed weight. TWAPs floor (assumption M-2).
library PricingMath {
    error Unsorted();
    error BadUnits();

    uint64 internal constant STALE_SECS = 30;
    uint64 internal constant INDEX_WINDOW = 300;
    uint64 internal constant PERP_WINDOW = 60;
    uint64 internal constant BASIS_WINDOW = 900;
    uint256 internal constant MONAD_TESTNET_CHAIN_ID = 10143;
    uint64 internal constant TESTNET_INDEX_WINDOW = 60;
    uint64 internal constant TESTNET_BASIS_WINDOW = 180;
    uint64 internal constant INVALID_WINDOW = 86400;
    uint64 internal constant MOVE_LOOKBACK = 300;
    uint256 internal constant MOVE_THRESHOLD_WAD = 1e17;
    uint256 internal constant BAND_WAD = 5e16;
    uint256 internal constant FUNDING_CLAMP_WAD = 5e16;

    uint8 internal constant FUNDING_OK = 0;
    uint8 internal constant FUNDING_DISABLED = 1;
    uint8 internal constant FUNDING_STALE_PRICE = 2;
    uint8 internal constant FUNDING_ZERO_OI = 3;

    /// @notice Shorter history is limited to Monad testnet. Production/default chains retain
    ///         the original windows; carry, PERP, risk parameters and epoch timing are unchanged.
    function indexWindow() internal view returns (uint64) {
        return block.chainid == MONAD_TESTNET_CHAIN_ID ? TESTNET_INDEX_WINDOW : INDEX_WINDOW;
    }

    function basisWindow() internal view returns (uint64) {
        return block.chainid == MONAD_TESTNET_CHAIN_ID ? TESTNET_BASIS_WINDOW : BASIS_WINDOW;
    }

    struct Sample {
        uint64 t; // observedAt
        int256 priceWad;
        bool valid; // depth/spread validity at observation
    }

    struct Twap {
        bool available;
        int256 twapWad;
        uint256 coveredSecs;
        int256 integral; // price-seconds over covered time
    }

    /// @dev Cumulative checkpoint for an append-only store: cumulative integral/coverage up to `t`,
    ///      excluding this sample's own carry.
    struct Cum {
        uint64 t;
        int256 priceWad;
        bool valid;
        int256 cumIntegral;
        uint256 cumCovered;
    }

    // ------------------------------------------------------------------ windows over arrays

    function twap(Sample[] memory ss, uint64 windowEnd, uint64 windowSecs, uint64 staleSecs)
        internal
        pure
        returns (Twap memory r)
    {
        if (windowSecs == 0 || staleSecs == 0 || windowSecs > windowEnd) revert BadUnits();
        uint64 start = windowEnd - windowSecs;
        for (uint256 i; i < ss.length; ++i) {
            if (i > 0 && ss[i].t < ss[i - 1].t) revert Unsorted();
            if (ss[i].t > windowEnd) break;
            bool hasNext = i + 1 < ss.length && ss[i + 1].t <= windowEnd;
            if (hasNext && ss[i + 1].t == ss[i].t) continue; // replaced at the same second
            if (!ss[i].valid) continue;
            uint64 segEnd = ss[i].t + staleSecs;
            if (i + 1 < ss.length && ss[i + 1].t < segEnd) segEnd = ss[i + 1].t;
            uint64 lo = ss[i].t > start ? ss[i].t : start;
            uint64 hi = segEnd < windowEnd ? segEnd : windowEnd;
            if (hi > lo) {
                r.coveredSecs += hi - lo;
                r.integral += ss[i].priceWad * int256(uint256(hi - lo));
            }
        }
        if (r.coveredSecs == windowSecs) {
            r.available = true;
            r.twapWad = QMath.floorDiv(r.integral, int256(uint256(windowSecs)));
        }
    }

    /// @notice Latest sample at or before t, if valid and fresh at t (t - observedAt <= stale).
    function valueAt(Sample[] memory ss, uint64 t, uint64 staleSecs)
        internal
        pure
        returns (bool ok, int256 p)
    {
        bool found;
        Sample memory last;
        for (uint256 i; i < ss.length; ++i) {
            if (i > 0 && ss[i].t < ss[i - 1].t) revert Unsorted();
            if (ss[i].t > t) break;
            last = ss[i];
            found = true;
        }
        if (!found || !last.valid || t - last.t > staleSecs) return (false, 0);
        return (true, last.priceWad);
    }

    // ------------------------------------------------------------------ cumulative (store form)

    function extend(Cum memory prev, uint64 t, int256 priceWad, bool valid, uint64 staleSecs)
        internal
        pure
        returns (Cum memory c)
    {
        if (t < prev.t) revert Unsorted();
        (c.cumIntegral, c.cumCovered) = cumAt(prev, t, staleSecs);
        c.t = t;
        c.priceWad = priceWad;
        c.valid = valid;
    }

    /// @notice Cumulative (integral, covered) at time t >= cp.t using the checkpoint's carry.
    function cumAt(Cum memory cp, uint64 t, uint64 staleSecs)
        internal
        pure
        returns (int256 integral, uint256 covered)
    {
        if (t < cp.t) revert Unsorted();
        integral = cp.cumIntegral;
        covered = cp.cumCovered;
        if (cp.valid) {
            uint64 end = cp.t + staleSecs < t ? cp.t + staleSecs : t;
            uint256 dt = end - cp.t;
            integral += cp.priceWad * int256(dt);
            covered += dt;
        }
    }

    /// @notice TWAP between two cumulative readings taken at `windowEnd - windowSecs` and `windowEnd`.
    function twapFromCum(int256 i0, uint256 c0, int256 i1, uint256 c1, uint64 windowSecs)
        internal
        pure
        returns (Twap memory r)
    {
        r.coveredSecs = c1 - c0;
        r.integral = i1 - i0;
        if (r.coveredSecs == windowSecs) {
            r.available = true;
            r.twapWad = QMath.floorDiv(r.integral, int256(uint256(windowSecs)));
        }
    }

    // ------------------------------------------------------------------ depth, basis, mark

    /// @notice Impact mid at depth N, or ok = false when either side cannot price N or the spread
    ///         check fails.
    function impactMid(
        uint256 impactBidWad,
        uint256 impactAskWad,
        uint256 bidDepthLots,
        uint256 askDepthLots,
        uint256 depthNLots,
        uint256 maxSpreadWad
    ) internal pure returns (bool ok, uint256 midWad) {
        if (depthNLots == 0) revert BadUnits();
        if (bidDepthLots < depthNLots || askDepthLots < depthNLots) return (false, 0);
        if (impactBidWad == 0 || impactBidWad > impactAskWad || impactAskWad >= WAD) return (false, 0);
        if (impactAskWad - impactBidWad > maxSpreadWad) return (false, 0);
        return (true, (impactBidWad + impactAskWad) / 2);
    }

    /// @notice b(t) = 0.05 max(T - t, 0) / (T - listedAt), floored (narrower band).
    function bandWad(uint256 nowTs, uint256 scheduledT, uint256 listedAt) internal pure returns (uint256) {
        if (scheduledT <= listedAt) revert BadUnits();
        uint256 left = scheduledT > nowTs ? scheduledT - nowTs : 0;
        return QMath.mulDiv(BAND_WAD, left, scheduledT - listedAt);
    }

    function median3(int256 a, int256 b, int256 c) internal pure returns (int256) {
        if (a > b) (a, b) = (b, a);
        if (b > c) (b, c) = (c, b);
        if (a > b) (a, b) = (b, a);
        return b;
    }

    struct MarkInputs {
        bool indexOk;
        uint256 indexWad;
        bool basisOk;
        int256 basisTwapWad;
        bool perpTwapOk;
        uint256 perpTwapWad;
        bool perpLiveOk;
        uint256 perpLiveWad;
    }

    /// @notice median(I + basis, perp 60 s TWAP, live perp) clamped to I +- b(t) and [0, 1]. All
    ///         candidates must be available in v1; otherwise the normal mark is unavailable.
    function mark(MarkInputs memory m, uint256 nowTs, uint256 scheduledT, uint256 listedAt)
        internal
        pure
        returns (bool ok, uint256 markWad)
    {
        if (!(m.indexOk && m.basisOk && m.perpTwapOk && m.perpLiveOk)) return (false, 0);
        int256 idx = QMath.signed(m.indexWad);
        int256 med = median3(idx + m.basisTwapWad, QMath.signed(m.perpTwapWad), QMath.signed(m.perpLiveWad));
        int256 b = QMath.signed(bandWad(nowTs, scheduledT, listedAt));
        if (med > idx + b) med = idx + b;
        if (med < idx - b) med = idx - b;
        if (med < 0) med = 0;
        if (med > int256(WAD)) med = int256(WAD);
        return (true, uint256(med));
    }

    // ------------------------------------------------------------------ funding

    /// @notice r = trunc0(f * 1000 * Q / 86400) Q per lot per second,
    ///         f = clamp(q - I, +-0.05 min(I, 1 - I)) per claim per day (beta = 0).
    function fundingRate(uint256 markWad, uint256 indexWad) internal pure returns (int256) {
        if (markWad > WAD || indexWad > WAD) revert BadUnits();
        uint256 bound = QMath.mulDiv(FUNDING_CLAMP_WAD, QMath.min(indexWad, WAD - indexWad), WAD);
        int256 f = int256(markWad) - int256(indexWad);
        if (f > int256(bound)) f = int256(bound);
        if (f < -int256(bound)) f = -int256(bound);
        // Solidity signed division truncates toward zero, which is the rule selected here (spec §4.4).
        return (f * 1000) / 86400;
    }

    function recommendEpochRate(
        bool fundingEnabled,
        bool priceOk,
        uint256 markWad,
        uint256 indexWad,
        uint256 oiLots
    ) internal pure returns (bool authorized, int256 rate, uint8 reason) {
        if (!fundingEnabled) return (false, 0, FUNDING_DISABLED);
        if (!priceOk) return (false, 0, FUNDING_STALE_PRICE);
        if (oiLots == 0) return (false, 0, FUNDING_ZERO_OI);
        return (true, fundingRate(markWad, indexWad), FUNDING_OK);
    }

    /// @notice |p(now) - p(now - 300)| > 0.10 restricts to reduce-only. Missing data never triggers.
    function movementTrigger(Sample[] memory index, uint64 nowTs) internal pure returns (bool) {
        if (nowTs < MOVE_LOOKBACK) return false;
        (bool okA, int256 a) = valueAt(index, nowTs, STALE_SECS);
        (bool okB, int256 b) = valueAt(index, nowTs - MOVE_LOOKBACK, STALE_SECS);
        if (!okA || !okB) return false;
        int256 d = a - b;
        return (d >= 0 ? uint256(d) : uint256(-d)) > MOVE_THRESHOLD_WAD;
    }
}
