// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {PricingMath} from "../math/PricingMath.sol";
import {RiskPricing} from "./RiskPricing.sol";

/// @title SourceGuards
/// @notice Continuous index freshness, the 30 s stale threshold and the 0.10 / 300 s movement
///         trigger (spec §4.1; B021).
/// @dev `fundingFreshThrough` is the end of continuous valid index coverage. Once a gap opens
///      inside a funding epoch, that epoch's freshness stop is latched at the gap start: a late
///      fresh observation extends continuous coverage again but can never erase the historical
///      gap or restart funding in the stopped epoch. Before the freshness endpoint moves, the
///      `_onFreshnessAdvance(oldFreshThrough)` hook lets Person A accrue old-epoch funding against
///      the previously known endpoint. This module never writes A funding state.
abstract contract SourceGuards is RiskPricing {
    event FreshnessGap(uint64 gapStart, uint64 resumedAt, uint64 epochStart);
    event MovementRestriction(uint64 at, uint256 priceNowWad, uint256 price300sAgoWad);

    uint64 internal _freshThrough; // continuous coverage end (observedAt + 30 of the last valid sample)
    uint64 internal _guardEpochStart; // start of the funding epoch the latch applies to
    uint64 internal _epochFreshStop; // 0 = no gap inside this epoch yet
    bool internal _movementRestricted;
    uint64 internal _movementAt;

    /// @dev Person A hook: accrue/stop old-epoch funding at `oldFreshThrough` before it moves.
    function _onFreshnessAdvance(uint64 oldFreshThrough) internal virtual {}

    /// @notice Reset the latch at a completed epoch opening (called with RiskPricing's hook).
    function _guardsOnEpochOpening(uint64 epochStart) internal {
        _guardEpochStart = epochStart;
        _epochFreshStop = 0;
        if (_freshThrough < epochStart) _epochFreshStop = epochStart; // opened stale: no funding
    }

    function _onIndexObservation(uint64 t, uint256 midWad, bool valid) internal virtual override {
        uint64 old = _freshThrough;
        _onFreshnessAdvance(old);
        if (!valid) {
            // A new sample ends the previous carry; an invalid one contributes no coverage.
            if (t < _freshThrough) _freshThrough = t;
            _latchGap(_freshThrough, t);
        } else {
            if (t > _freshThrough && _freshThrough != 0) _latchGap(_freshThrough, t);
            _freshThrough = t + uint64(PricingMath.STALE_SECS);
        }
        super._onIndexObservation(t, midWad, valid);
        if (valid) _checkMovement(t);
    }

    function _latchGap(uint64 gapStart, uint64 resumedAt) internal {
        if (gapStart >= _guardEpochStart && _epochFreshStop == 0) {
            _epochFreshStop = gapStart;
            emit FreshnessGap(gapStart, resumedAt, _guardEpochStart);
        }
    }

    function _checkMovement(uint64 t) internal {
        if (t < PricingMath.MOVE_LOOKBACK) return;
        (bool okA, int256 a) = _valueAt(INDEX, t);
        (bool okB, int256 b) = _valueAt(INDEX, t - PricingMath.MOVE_LOOKBACK);
        if (!okA || !okB) return;
        uint256 d = a >= b ? uint256(a - b) : uint256(b - a);
        if (d > PricingMath.MOVE_THRESHOLD_WAD && !_movementRestricted) {
            _movementRestricted = true;
            _movementAt = t;
            emit MovementRestriction(t, uint256(a), uint256(b));
        }
    }

    /// @notice The funding-relevant freshness endpoint: the latched gap start of the current epoch
    ///         if any, else the continuous coverage end.
    function _fundingFreshThrough() internal view virtual override returns (uint64) {
        return _epochFreshStop != 0 ? _epochFreshStop : _freshThrough;
    }

    function _indexFreshAt(uint64 t) internal view returns (bool) {
        return _freshThrough != 0 && t <= _freshThrough;
    }

    function freshness()
        external
        view
        returns (uint64 freshThrough, uint64 epochFreshStop, bool movementRestricted)
    {
        return (_freshThrough, _epochFreshStop, _movementRestricted);
    }
}
