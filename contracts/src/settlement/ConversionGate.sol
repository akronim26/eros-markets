// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {SettlementController} from "./SettlementController.sol";

/// @title ConversionGate
/// @notice Fences the optional outcome-token conversion (spec §8.6, DEC-10; B038). Cash
///         settlement is the first release: conversion is disabled in the baseline and can never
///         be selected. The fence still encodes the future rules so enabling it later needs no
///         redesign: one market-wide mode chosen before any cash claim, cash and token claims
///         mutually exclusive, and every frozen account (reserve included) fully backed at the
///         prepared halt snapshot.
/// @dev Person A's cash-claim path (A037) must call `_riskBeforeCashClaim()` before paying.
abstract contract ConversionGate is SettlementController {
    error ConversionDisabled();
    error ConversionNotEligible(uint8 reason);
    error CashClaimsClosedByConversion();

    enum ClaimMode {
        UNSELECTED,
        CASH,
        CONVERSION
    }

    uint8 public constant ELIGIBLE = 0;
    uint8 public constant R_DISABLED = 1;
    uint8 public constant R_SNAPSHOT_INCOMPLETE = 2;
    uint8 public constant R_CASH_CLAIM_STARTED = 3;
    uint8 public constant R_UNDERBACKED = 4;
    uint8 public constant R_MODE_SELECTED = 5;

    ClaimMode internal _claimMode;

    event ClaimModeSelected(ClaimMode mode);

    /// @dev Baseline: false and unchangeable. A later, separately gated listing may override.
    function _conversionEnabled() internal view virtual returns (bool) {
        return false;
    }

    function conversionEligibility() public view returns (uint8 reason) {
        if (!_conversionEnabled()) return R_DISABLED;
        if (_claimMode != ClaimMode.UNSELECTED) return R_MODE_SELECTED;
        if (!_halt.halted || !_snapJob.done) return R_SNAPSHOT_INCOMPLETE;
        if (_acctAnyCashClaim()) return R_CASH_CLAIM_STARTED;
        if (!_acctAllFullyBackedAtHalt()) return R_UNDERBACKED;
        return ELIGIBLE;
    }

    function selectConversionMode() external {
        if (!_conversionEnabled()) revert ConversionDisabled();
        uint8 r = conversionEligibility();
        if (r != ELIGIBLE) revert ConversionNotEligible(r);
        _claimMode = ClaimMode.CONVERSION;
        emit ClaimModeSelected(ClaimMode.CONVERSION);
    }

    /// @notice Hook for A's cash claim: fixes the market to CASH mode on the first claim.
    function _riskBeforeCashClaim() internal {
        if (_claimMode == ClaimMode.CONVERSION) revert CashClaimsClosedByConversion();
        if (_claimMode == ClaimMode.UNSELECTED) {
            _claimMode = ClaimMode.CASH;
            emit ClaimModeSelected(ClaimMode.CASH);
        }
    }

    function claimMode() external view returns (ClaimMode) {
        return _claimMode;
    }
}
