// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {MarginMath} from "../math/MarginMath.sol";
import {HorizonMath} from "../math/HorizonMath.sol";
import {RiskPricing} from "../pricing/RiskPricing.sol";
import {SourceGuards} from "../pricing/SourceGuards.sol";
import {ObservationStore} from "../pricing/ObservationStore.sol";
import {RiskContextPort} from "./RiskContextPort.sol";

/// @title MonitorPolicy
/// @notice Authenticated monitor restrictions (spec §5.4, §8.3; B021). The pinned monitor may
///         impose or lift reduce-only and may raise (never lower) hazards. A raise applies at once
///         as reduce-only and becomes the tariff/profile only at the next completed epoch. The
///         monitor cannot halt, settle, choose an outcome or move balances: this module has no
///         path to any of those.
/// @dev Missing or expired calibration forces the 1x / full-backing mode through
///      `_effectiveParams()`, which marks the profile uncalibrated when either empirical envelope
///      is outside its validity window.
abstract contract MonitorPolicy is RiskContextPort, SourceGuards {
    error HazardDecrease();

    event MonitorRestriction(bool restricted, bytes32 reason, uint64 at);
    event HazardRaiseRequested(uint256 hazard0WadPerDay, uint256 hazard1WadPerDay, uint64 at);

    bool internal _monitorFlag;

    function requestReduceOnly(bytes32 reason) external {
        _onlyMonitor();
        _monitorFlag = true;
        emit MonitorRestriction(true, reason, uint64(block.timestamp));
    }

    /// @notice A failed early check restores trading per policy; this also clears a movement flag.
    function clearReduceOnly(bytes32 reason) external {
        _onlyMonitor();
        _monitorFlag = false;
        _movementRestricted = false;
        emit MonitorRestriction(false, reason, uint64(block.timestamp));
    }

    /// @notice Raise hazards: reduce-only now, new profile staged for the next completed epoch.
    function raiseHazards(uint256 hazard0WadPerDay, uint256 hazard1WadPerDay) external {
        _onlyMonitor();
        MarginMath.RiskParams memory p = _hasStagedProfile ? _stagedParams : _params;
        if (hazard0WadPerDay < p.hazard0WadPerDay || hazard1WadPerDay < p.hazard1WadPerDay) {
            revert HazardDecrease();
        }
        p.hazard0WadPerDay = hazard0WadPerDay;
        p.hazard1WadPerDay = hazard1WadPerDay;
        _validateRiskProfile(_listing, p);
        _stagedParams = p;
        _stageRiskProfile(profileHashOf(p));
        _monitorFlag = true;
        emit HazardRaiseRequested(hazard0WadPerDay, hazard1WadPerDay, uint64(block.timestamp));
    }

    function _onIndexObservation(uint64 t, uint256 midWad, bool valid)
        internal
        virtual
        override(ObservationStore, SourceGuards)
    {
        SourceGuards._onIndexObservation(t, midWad, valid);
    }

    function _monitorRestricted() internal view virtual override returns (bool) {
        return _monitorFlag || _movementRestricted;
    }

    function _fundingFreshThrough()
        internal
        view
        virtual
        override(RiskPricing, SourceGuards)
        returns (uint64)
    {
        return SourceGuards._fundingFreshThrough();
    }

    /// @notice Active params, forced to uncalibrated (cap 1, full backing) when calibration is
    ///         missing or expired at `nowTs`.
    function _effectiveParams(uint256 nowTs) internal view returns (MarginMath.RiskParams memory p) {
        p = _params;
        if (!_envelopeLive(p.realized, nowTs) || !_envelopeLive(p.templateEnv, nowTs)) p.calibrated = false;
    }

    function _envelopeLive(HorizonMath.Envelope memory e, uint256 nowTs) private pure returns (bool) {
        return HorizonMath.isValidEnvelope(e) && nowTs >= e.validFrom && nowTs < e.validUntil;
    }

    /// @notice Epoch opening for the composed engine: guards latch reset + profile/pricing switch.
    function _riskEpochOpenedWithGuards() internal {
        _riskEpochOpened();
        _guardsOnEpochOpening(uint64(block.timestamp));
    }
}
