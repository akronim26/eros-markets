// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {PricingMode, Stage} from "../../provisional/MathTypes.sol";
import {PricingMath} from "../math/PricingMath.sol";
import {LifecycleMath} from "../math/LifecycleMath.sol";
import {ObservationStore} from "./ObservationStore.sol";

/// @notice Immutable per-action risk context (spec §3.3 step 3, §4.1; B018). It freezes prices,
///         stage and parameter version for one transaction only; it never carries cash, OI,
///         budgets or coverage (those are mutable and belong to Person A).
struct RiskContext {
    uint64 economicTime; // block.timestamp of the action (seconds)
    uint64 scheduledT;
    uint64 listedAt;
    uint64 secsToT;
    Stage stage;
    bool fullBackingByTime;
    bool fundingFrozen;
    bool legacyTakeoverWindow;
    bool halted;
    PricingMode pricingMode;
    bool indexOk;
    uint256 indexWad; // 300 s independent index TWAP
    bool markOk;
    uint256 markWad; // normal mark; unavailable is markOk == false, never 0
    LifecycleMath.Admission admission; // NONE / BACKED_ONLY / LEVERAGED
    uint64 riskVersion;
    bytes32 profileHash;
    uint64 fundingFreshThrough; // continuous-freshness endpoint (B021)
    bool monitorRestricted;
}

/// @title RiskPricing
/// @notice Builds the RiskContext from the observation store, config and time, and runs the
///         exactly-backed bootstrap and the full-window normal-pricing transition (B018).
/// @dev Leveraged admission and mark-based liquidation need NORMAL_PRICING with every mark
///      candidate valid. With a valid independent index but no normal mark, only exactly backed
///      orders inside the index order band may trade. A halt overrides every pricing mode.
abstract contract RiskPricing is ObservationStore {
    error OutsideBootstrapBand();

    event PricingModeChanged(PricingMode mode, uint64 at, uint64 riskVersion);
    event RiskProfileActivated(uint64 riskVersion, bytes32 profileHash, uint64 effectiveAt);

    uint64 internal _scheduledT;
    uint64 internal _listedAt;
    uint256 internal _bootstrapBandWad; // immutable listing band around I for backed-only orders
    PricingMode internal _pricingMode;
    uint64 internal _riskVersion;
    bytes32 internal _profileHash;
    bytes32 internal _stagedProfileHash;
    bool internal _hasStagedProfile;

    function _initRiskPricing(
        uint64 scheduledT,
        uint64 listedAt,
        uint256 bootstrapBandWad,
        bytes32 profileHash
    ) internal {
        _scheduledT = scheduledT;
        _listedAt = listedAt;
        _bootstrapBandWad = bootstrapBandWad;
        _pricingMode = PricingMode.BOOTSTRAP;
        _riskVersion = 1;
        _profileHash = profileHash;
        _initStore(scheduledT);
    }

    // ------------------------------------------------------------------ hooks for other modules

    /// @dev 0 = no early halt accepted (B034 overrides).
    function _earlyHaltAt() internal view virtual returns (uint64) {
        return 0;
    }

    /// @dev Authenticated monitor reduce-only flag (B021 overrides).
    function _monitorRestricted() internal view virtual returns (bool) {
        return false;
    }

    /// @dev Continuous funding-freshness endpoint (B021 overrides).
    function _fundingFreshThrough() internal view virtual returns (uint64) {
        return 0;
    }

    /// @dev Claims readiness for the stage view (B036 overrides).
    function _claimsReady() internal view virtual returns (bool) {
        return false;
    }

    // ------------------------------------------------------------------ context

    function _riskContext() internal view returns (RiskContext memory c) {
        uint64 nowTs = uint64(block.timestamp);
        c.economicTime = nowTs;
        c.scheduledT = _scheduledT;
        c.listedAt = _listedAt;
        c.secsToT = _scheduledT > nowTs ? _scheduledT - nowTs : 0;
        c.monitorRestricted = _monitorRestricted();
        LifecycleMath.StageView memory v = LifecycleMath.deriveStage(
            nowTs, _scheduledT, _earlyHaltAt(), c.monitorRestricted, _claimsReady()
        );
        (c.stage, c.fullBackingByTime, c.fundingFrozen, c.legacyTakeoverWindow, c.halted) =
        (v.stage, v.fullBackingByTime, v.fundingFrozen, v.legacyTakeoverWindow, v.halted);
        c.pricingMode = _pricingMode;
        c.riskVersion = _riskVersion;
        c.profileHash = _profileHash;
        c.fundingFreshThrough = _fundingFreshThrough();

        PricingMath.MarkInputs memory m = _markInputs(nowTs);
        c.indexOk = m.indexOk;
        c.indexWad = m.indexWad;
        (bool markOk, uint256 markWad) = PricingMath.mark(m, nowTs, _scheduledT, _listedAt);
        // A normal mark exists only in NORMAL_PRICING; warm-up data is never a leveraged mark.
        c.markOk = markOk && _pricingMode == PricingMode.NORMAL_PRICING;
        c.markWad = c.markOk ? markWad : 0;
        (, c.admission) = LifecycleMath.pricingTransition(
            _pricingMode, false, m.indexOk, m.basisOk, m.perpTwapOk, m.perpLiveOk, c.halted
        );
    }

    function _markInputs(uint64 nowTs) internal view returns (PricingMath.MarkInputs memory m) {
        PricingMath.Twap memory idx = _windowTwap(INDEX, nowTs, PricingMath.INDEX_WINDOW);
        PricingMath.Twap memory bas = _windowTwap(BASIS, nowTs, PricingMath.BASIS_WINDOW);
        PricingMath.Twap memory prp = _windowTwap(PERP, nowTs, PricingMath.PERP_WINDOW);
        (bool liveOk, int256 live) = _valueAt(PERP, nowTs);
        m.indexOk = idx.available && idx.twapWad > 0;
        m.indexWad = m.indexOk ? uint256(idx.twapWad) : 0;
        m.basisOk = bas.available;
        m.basisTwapWad = bas.twapWad;
        m.perpTwapOk = prp.available && prp.twapWad > 0;
        m.perpTwapWad = m.perpTwapOk ? uint256(prp.twapWad) : 0;
        m.perpLiveOk = liveOk && live > 0;
        m.perpLiveWad = m.perpLiveOk ? uint256(live) : 0;
    }

    // ------------------------------------------------------------------ bootstrap and epochs

    /// @notice Exactly backed bootstrap order check: price inside [I - band, I + band]. The caller
    ///         must also require both order-aware endpoint deficits to be zero (full backing).
    function _checkBootstrapBand(RiskContext memory c, uint16 tick) internal view {
        if (!c.indexOk) revert OutsideBootstrapBand();
        uint256 p = uint256(tick) * 1e15;
        uint256 lo = c.indexWad > _bootstrapBandWad ? c.indexWad - _bootstrapBandWad : 0;
        uint256 hi = c.indexWad + _bootstrapBandWad;
        if (p < lo || p > hi) revert OutsideBootstrapBand();
    }

    /// @notice Leveraged exposure needs NORMAL_PRICING with all candidates (spec §4.1).
    function _leveragedAllowed(RiskContext memory c) internal pure returns (bool) {
        return c.admission == LifecycleMath.Admission.LEVERAGED && c.markOk && !c.halted;
    }

    /// @notice Mark-based liquidation needs a normal mark; a stale mark is never evidence.
    function _markLiquidationAllowed(RiskContext memory c) internal pure returns (bool) {
        return c.markOk && c.pricingMode == PricingMode.NORMAL_PRICING && !c.halted;
    }

    /// @notice Stage a new calibration profile; it activates only at the next completed epoch.
    function _stageRiskProfile(bytes32 profileHash) internal {
        _stagedProfileHash = profileHash;
        _hasStagedProfile = true;
    }

    /// @notice Called once when Person A commits a completed accounting epoch. Applies any staged
    ///         profile and performs BOOTSTRAP -> NORMAL_PRICING only if every window is valid now.
    function _onEpochOpening() internal returns (PricingMode) {
        uint64 nowTs = uint64(block.timestamp);
        if (_hasStagedProfile) {
            _profileHash = _stagedProfileHash;
            _hasStagedProfile = false;
            _riskVersion += 1;
            emit RiskProfileActivated(_riskVersion, _profileHash, nowTs);
        }
        PricingMath.MarkInputs memory m = _markInputs(nowTs);
        bool halted = LifecycleMath.deriveStage(nowTs, _scheduledT, _earlyHaltAt(), false, false).halted;
        (PricingMode next,) = LifecycleMath.pricingTransition(
            _pricingMode, true, m.indexOk, m.basisOk, m.perpTwapOk, m.perpLiveOk, halted
        );
        if (next != _pricingMode) {
            _pricingMode = next;
            emit PricingModeChanged(next, nowTs, _riskVersion);
        }
        return _pricingMode;
    }

    function pricingMode() external view returns (PricingMode) {
        return _pricingMode;
    }

    /// @notice Unit-labelled context view (prices wad, times seconds). Unavailable prices are
    ///         flagged, never reported as a zero price.
    function riskContext() external view returns (RiskContext memory) {
        return _riskContext();
    }
}
