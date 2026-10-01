// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {LifecycleMath} from "../math/LifecycleMath.sol";
import {PricingMath} from "../math/PricingMath.sol";
import {ResolutionIngress} from "./ResolutionIngress.sol";

/// @title InvalidPrice
/// @notice Deterministic INVALID price capture (spec §8.4, DEC-08; B035). Permissionless
///         `captureInvalidPrice()` at or after T reads the unpruned independent-index record of
///         the listed window [T - 24h, T]. A complete window captures its time-weighted average
///         (floored to pE18). For a listing that disclosed the missing-data rule, an incomplete
///         window waits until T + 1h and then captures the fixed 0.5 fallback. A legacy listing
///         without that rule is reported BLOCKED and never gets a chosen price. Captured once;
///         later observations cannot revise it; capture is independent of oracle finality.
/// @dev Index samples after the halt only feed this window; they never restart funding or risk
///      (the context stays HALTED and funding cutoffs stop at the halt).
abstract contract InvalidPrice is ResolutionIngress {
    uint8 public constant REASON_TWAP = 1;
    uint8 public constant REASON_FALLBACK_MISSING_INDEX = 2;

    bool internal _invalidCaptured;
    uint256 internal _invalidPriceWad;
    uint8 internal _invalidReason;
    bytes32 internal _invalidProvenance;

    event InvalidPriceCaptured(
        bytes32 indexed marketId,
        uint256 priceE18,
        uint64 windowStart,
        uint64 windowEnd,
        bytes32 provenanceHash,
        uint8 reason
    );

    /// @return status readiness at call time; captured whether a price is (now) captured.
    function captureInvalidPrice() external returns (LifecycleMath.InvalidReadiness status, bool captured) {
        if (_invalidCaptured) return (_capturedStatus(), true);
        PricingMath.Twap memory tw = _invalidWindowTwap();
        status = _invalidStatus(tw.available);
        if (status == LifecycleMath.InvalidReadiness.CAPTURE_TWAP) {
            _capture(uint256(tw.twapWad), REASON_TWAP, tw);
            return (status, true);
        }
        if (status == LifecycleMath.InvalidReadiness.CAPTURE_FALLBACK) {
            _capture(_listing.invalidRule.fallbackPriceWad, REASON_FALLBACK_MISSING_INDEX, tw);
            return (status, true);
        }
        return (status, false);
    }

    function _invalidStatus(bool windowComplete) internal view returns (LifecycleMath.InvalidReadiness) {
        return LifecycleMath.invalidReadiness(
            block.timestamp,
            _scheduledT,
            windowComplete,
            _listing.invalidRule.fallbackListed,
            _listing.invalidRule.captureGraceSecs
        );
    }

    function _capturedStatus() internal view returns (LifecycleMath.InvalidReadiness) {
        return _invalidReason == REASON_FALLBACK_MISSING_INDEX
            ? LifecycleMath.InvalidReadiness.CAPTURE_FALLBACK
            : LifecycleMath.InvalidReadiness.CAPTURE_TWAP;
    }

    function _capture(uint256 priceWad, uint8 reason, PricingMath.Twap memory tw) internal {
        if (priceWad > 1e18) revert PricingMath.BadUnits();
        _invalidCaptured = true;
        _invalidPriceWad = priceWad;
        _invalidReason = reason;
        _invalidProvenance = keccak256(
            abi.encode(
                _listing.marketId, _invalidStart, _invalidEnd, tw.integral, tw.coveredSecs, reason, priceWad
            )
        );
        emit InvalidPriceCaptured(
            _listing.marketId, priceWad, _invalidStart, _invalidEnd, _invalidProvenance, reason
        );
    }

    /// @notice Captured INVALID price, or ready == false (pending / blocked). Never a guessed 0.
    function invalidPrice()
        external
        view
        returns (
            bool ready,
            uint256 priceE18,
            uint8 reason,
            bytes32 provenance,
            LifecycleMath.InvalidReadiness status
        )
    {
        if (_invalidCaptured) {
            return (true, _invalidPriceWad, _invalidReason, _invalidProvenance, _capturedStatus());
        }
        status = _invalidStatus(_invalidWindowTwap().available);
        return (false, 0, 0, bytes32(0), status);
    }
}
