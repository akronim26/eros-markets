// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {PricingMath} from "../math/PricingMath.sol";
import {PriceIngress} from "./PriceIngress.sol";

/// @title ObservationStore
/// @notice Valid-window observation storage (spec §4.1, §8.4; B017). Keeps cumulative
///         validity-weighted integrals for the independent INDEX, this market's PERP impact mid
///         and the BASIS (perp mid minus contemporaneous index), and a separate O(1) record of the
///         listed INVALID window [T - 24h, T] that is never pruned.
/// @dev Growth bound: each live series is a ring of RING checkpoints; a later sample at the same
///      second replaces the earlier one, so RING entries always span >= RING - 1 seconds, more
///      than the longest live window (900 s) plus the 30 s carry. Queries are binary searches
///      (<= 11 probes). No loop over history runs inside matching.
abstract contract ObservationStore is PriceIngress {
    error NonMonotoneSample();

    uint8 internal constant INDEX = 0;
    uint8 internal constant PERP = 1;
    uint8 internal constant BASIS = 2;
    uint256 internal constant RING = 1024;
    uint64 internal constant STALE = 30;

    struct Ring {
        uint16 head; // index of the newest entry
        uint16 count;
    }

    mapping(uint8 series => Ring) internal _rings;
    mapping(uint8 series => PricingMath.Cum[RING]) internal _cps;

    // INVALID window record: latest index checkpoint at/before window start and at/before T.
    uint64 internal _invalidStart;
    uint64 internal _invalidEnd;
    PricingMath.Cum internal _invStartCp;
    PricingMath.Cum internal _invEndCp;
    bool internal _hasInvStart;
    bool internal _hasInvEnd;

    event PerpObservationRecorded(uint64 t, uint256 midWad, bool valid, int256 basisWad, bool basisValid);

    function _initStore(uint64 scheduledT) internal {
        _invalidStart = scheduledT - uint64(PricingMath.INVALID_WINDOW);
        _invalidEnd = scheduledT;
    }

    // ------------------------------------------------------------------ appends

    function _onIndexObservation(uint64 t, uint256 midWad, bool valid) internal virtual override {
        PricingMath.Cum memory cp = _append(INDEX, t, int256(midWad), valid);
        if (t <= _invalidStart) {
            _invStartCp = cp;
            _hasInvStart = true;
        }
        if (t <= _invalidEnd) {
            _invEndCp = cp;
            _hasInvEnd = true;
        }
    }

    /// @notice Record this market's perp impact mid at depth N (from the book's depth summary).
    function _recordPerp(
        uint64 t,
        uint256 impactBidWad,
        uint256 impactAskWad,
        uint256 bidDepthLots,
        uint256 askDepthLots
    ) internal {
        (bool ok, uint256 mid) = PricingMath.impactMid(
            impactBidWad,
            impactAskWad,
            bidDepthLots,
            askDepthLots,
            _depthRule.depthNLots,
            _depthRule.maxSpreadWad
        );
        _append(PERP, t, int256(mid), ok);
        (bool iok, int256 idx) = _valueAt(INDEX, t);
        bool bok = ok && iok;
        int256 basis = bok ? int256(mid) - idx : int256(0);
        _append(BASIS, t, basis, bok);
        emit PerpObservationRecorded(t, mid, ok, basis, bok);
    }

    function _append(uint8 s, uint64 t, int256 price, bool valid)
        internal
        returns (PricingMath.Cum memory cp)
    {
        Ring storage r = _rings[s];
        if (r.count == 0) {
            cp = PricingMath.Cum(t, price, valid, 0, 0);
            _cps[s][0] = cp;
            r.head = 0;
            r.count = 1;
            return cp;
        }
        PricingMath.Cum storage last = _cps[s][r.head];
        if (t < last.t) revert NonMonotoneSample();
        if (t == last.t) {
            // Same second: replace; cumulative values up to t do not depend on this sample.
            last.priceWad = price;
            last.valid = valid;
            return last;
        }
        cp = PricingMath.extend(last, t, price, valid, STALE);
        uint16 next = uint16((uint256(r.head) + 1) % RING);
        _cps[s][next] = cp;
        r.head = next;
        if (r.count < RING) r.count += 1;
    }

    // ------------------------------------------------------------------ queries

    /// @dev Latest checkpoint with cp.t <= t. ok == false if t precedes retained history.
    function _floorCp(uint8 s, uint64 t) internal view returns (bool ok, PricingMath.Cum memory cp) {
        Ring memory r = _rings[s];
        if (r.count == 0) return (false, cp);
        uint256 oldest = (uint256(r.head) + RING + 1 - r.count) % RING;
        if (_cps[s][oldest].t > t) {
            // Before retained history: answerable only if nothing was ever overwritten and no
            // sample existed yet (cumulative zero), i.e. the ring has never wrapped.
            if (r.count < RING) return (true, PricingMath.Cum(t, 0, false, 0, 0));
            return (false, cp);
        }
        uint256 lo = 0;
        uint256 hi = r.count - 1; // offsets from oldest
        while (lo < hi) {
            uint256 mid = (lo + hi + 1) / 2;
            if (_cps[s][(oldest + mid) % RING].t <= t) lo = mid;
            else hi = mid - 1;
        }
        return (true, _cps[s][(oldest + lo) % RING]);
    }

    function _cumAt(uint8 s, uint64 t) internal view returns (bool ok, int256 integral, uint256 covered) {
        PricingMath.Cum memory cp;
        (ok, cp) = _floorCp(s, t);
        if (!ok) return (false, 0, 0);
        (integral, covered) = PricingMath.cumAt(cp, t, STALE);
    }

    /// @notice Time-weighted average over [end - window, end]; unavailable unless fully covered.
    function _windowTwap(uint8 s, uint64 end, uint64 window)
        internal
        view
        returns (PricingMath.Twap memory tw)
    {
        if (window == 0 || window > end) return tw;
        (bool ok0, int256 i0, uint256 c0) = _cumAt(s, end - window);
        (bool ok1, int256 i1, uint256 c1) = _cumAt(s, end);
        if (!ok0 || !ok1) return tw;
        return PricingMath.twapFromCum(i0, c0, i1, c1, window);
    }

    /// @notice Latest sample at or before t if valid and fresh (t - observedAt <= 30 s).
    function _valueAt(uint8 s, uint64 t) internal view returns (bool ok, int256 v) {
        (bool found, PricingMath.Cum memory cp) = _floorCp(s, t);
        if (!found || !cp.valid || cp.t > t || t - cp.t > STALE) return (false, 0);
        return (true, cp.priceWad);
    }

    /// @notice Configured windows in seconds. Monad testnet uses (60, 60, 180, 30);
    ///         all other chains use (300, 60, 900, 30).
    function pricingWindows()
        external
        view
        returns (uint64 indexWindowSecs, uint64 perpWindowSecs, uint64 basisWindowSecs, uint64 carryLimitSecs)
    {
        return (PricingMath.indexWindow(), PricingMath.PERP_WINDOW, PricingMath.basisWindow(), STALE);
    }

    /// @notice Legacy ABI name: reads the configured INDEX window, which is 60 s on Monad testnet.
    function indexTwap300(uint64 end) public view returns (PricingMath.Twap memory) {
        return _windowTwap(INDEX, end, PricingMath.indexWindow());
    }

    function perpTwap60(uint64 end) public view returns (PricingMath.Twap memory) {
        return _windowTwap(PERP, end, PricingMath.PERP_WINDOW);
    }

    /// @notice Legacy ABI name: reads the configured BASIS window, which is 180 s on Monad testnet.
    function basisTwap900(uint64 end) public view returns (PricingMath.Twap memory) {
        return _windowTwap(BASIS, end, PricingMath.basisWindow());
    }

    /// @notice Listed INVALID window integral from the unpruned record. Available only when the
    ///         whole 86,400 s has contiguous valid coverage (no carry across a 30 s gap).
    function _invalidWindowTwap() internal view returns (PricingMath.Twap memory tw) {
        if (!_hasInvStart || !_hasInvEnd) return tw;
        (int256 i0, uint256 c0) = PricingMath.cumAt(_invStartCp, _invalidStart, STALE);
        (int256 i1, uint256 c1) = PricingMath.cumAt(_invEndCp, _invalidEnd, STALE);
        return PricingMath.twapFromCum(i0, c0, i1, c1, uint64(PricingMath.INVALID_WINDOW));
    }

    function invalidWindow() public view returns (uint64 start, uint64 end, bool haveStart, bool haveEnd) {
        return (_invalidStart, _invalidEnd, _hasInvStart, _hasInvEnd);
    }

    function ringCount(uint8 s) external view returns (uint16) {
        return _rings[s].count;
    }
}
