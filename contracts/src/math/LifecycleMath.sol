// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Stage, PricingMode} from "./RiskTypes.sol";
import {MathTypes} from "./MathTypes.sol";

/// @title LifecycleMath
/// @notice Time-derived stage, cutoff precedence, grace, bootstrap transition, INVALID readiness
///         and finality acceptance (spec §5.1, §6.4, §8.3–8.5; reference/b/lifecycle.py).
/// @dev Pure predicates over time and flags. Nothing here reads or returns cash or positions.
library LifecycleMath {
    error BadOutcome();
    error ConflictingFinalOutcome();

    uint256 internal constant GRACE_START = 45000; // T - 12h30m
    uint256 internal constant FLOOR_START = 43200; // T - 12h
    uint256 internal constant REDUCE_ONLY_START = 3600; // T - 1h
    uint256 internal constant INVALID_WINDOW = 86400;
    uint256 internal constant INVALID_GRACE = 3600;
    uint256 internal constant VOID_SECS = 30 days;
    uint256 internal constant MIN_LISTING_HORIZON = 1 days;

    enum Admission {
        NONE,
        BACKED_ONLY,
        LEVERAGED
    }

    enum InvalidReadiness {
        NOT_YET,
        CAPTURE_TWAP,
        WAIT_GRACE,
        CAPTURE_FALLBACK,
        BLOCKED
    }

    enum ClaimsStatus {
        AWAITING_OUTCOME,
        ORACLE_FINAL_PRICE_PENDING,
        ORACLE_FINAL_PREPARING,
        RECOVERY_REQUIRED,
        CLAIMABLE
    }

    struct StageView {
        Stage stage;
        bool fullBackingByTime; // new commitments must be exactly backed
        bool fundingFrozen; // at/after T - 12h
        bool legacyTakeoverWindow; // floor: legacy deficient accounts may be taken over
        bool halted;
    }

    struct GraceState {
        bool active;
        uint64 anchor; // effectiveAt of the risk epoch where the deficiency was first seen
    }

    /// @notice Strongest restriction wins; boundaries inclusive. `haltAt == 0` = no early halt.
    function deriveStage(
        uint256 nowTs,
        uint256 scheduledT,
        uint256 haltAt,
        bool monitorRestricted,
        bool claimsReady
    ) internal pure returns (StageView memory v) {
        v.halted = nowTs >= scheduledT || (haltAt != 0 && nowTs >= haltAt);
        uint256 toT = scheduledT > nowTs ? scheduledT - nowTs : 0;
        bool floor = toT <= FLOOR_START;
        bool grace = toT <= GRACE_START;
        if (v.halted) v.stage = claimsReady ? Stage.CLAIMS_READY : Stage.HALTED;
        else if (toT <= REDUCE_ONLY_START || monitorRestricted) v.stage = Stage.REDUCE_ONLY;
        else if (floor) v.stage = Stage.BACKING_FLOOR;
        else if (grace) v.stage = Stage.BACKING_GRACE;
        else v.stage = Stage.TRADING;
        v.fullBackingByTime = grace || v.halted;
        v.fundingFrozen = floor || v.halted;
        v.legacyTakeoverWindow = floor && !v.halted;
    }

    /// @notice Scheduled markets halt at T even if the keeper is late; an early halt uses its own time.
    function economicHaltAt(uint256 scheduledT, uint256 earlyHaltAt) internal pure returns (uint256) {
        return earlyHaltAt != 0 && earlyHaltAt < scheduledT ? earlyHaltAt : scheduledT;
    }

    /// @notice min(economicHaltAt, activeEpoch.end), respecting a frozen rollover cutoff (0 = none).
    function accrualCutoff(uint256 haltAt, uint256 activeEpochEnd, uint256 frozenRolloverCutoff)
        internal
        pure
        returns (uint256)
    {
        uint256 end = activeEpochEnd;
        if (frozenRolloverCutoff != 0 && frozenRolloverCutoff < end) end = frozenRolloverCutoff;
        return haltAt < end ? haltAt : end;
    }

    struct FundingCutoffInputs {
        uint256 nowTs;
        uint256 activeEpochEnd;
        uint256 scheduledT;
        uint256 fundingStopAt; // 0 = none
        uint256 fundingFreshThrough;
        uint256 haltAt; // 0 = none
        uint256 frozenRolloverCutoff; // 0 = none
    }

    /// @notice Earliest of every stop; never later than any of them.
    function fundingCutoff(FundingCutoffInputs memory i) internal pure returns (uint256 c) {
        c = i.nowTs;
        if (i.activeEpochEnd < c) c = i.activeEpochEnd;
        if (i.scheduledT - FLOOR_START < c) c = i.scheduledT - FLOOR_START;
        if (i.fundingFreshThrough < c) c = i.fundingFreshThrough;
        if (i.fundingStopAt != 0 && i.fundingStopAt < c) c = i.fundingStopAt;
        if (i.haltAt != 0 && i.haltAt < c) c = i.haltAt;
        if (i.frozenRolloverCutoff != 0 && i.frozenRolloverCutoff < c) c = i.frozenRolloverCutoff;
    }

    /// @notice Nonrenewable grace (assumption M-5): set once, cleared only at/above IM.
    function graceOnTouch(GraceState memory g, bool belowIm, uint64 riskEpochEffectiveAt)
        internal
        pure
        returns (GraceState memory)
    {
        if (!belowIm) return GraceState(false, 0);
        if (g.active) return g;
        return GraceState(true, riskEpochEffectiveAt);
    }

    function graceExpired(
        GraceState memory g,
        uint256 graceSecs,
        uint256 nowTs,
        uint256 scheduledT,
        bool belowMm
    ) internal pure returns (bool) {
        if (belowMm) return true;
        if (!g.active) return false;
        uint256 end = uint256(g.anchor) + graceSecs;
        if (scheduledT - FLOOR_START < end) end = scheduledT - FLOOR_START;
        return nowTs >= end;
    }

    /// @notice BOOTSTRAP -> NORMAL only at a completed epoch opening with every candidate valid.
    ///         Halt overrides every mode; a missing index forbids new exposure.
    function pricingTransition(
        PricingMode mode,
        bool atCompletedEpochOpening,
        bool indexValid,
        bool basisValid,
        bool perpTwapValid,
        bool perpLiveValid,
        bool halted
    ) internal pure returns (PricingMode next, Admission admission) {
        bool allValid = indexValid && basisValid && perpTwapValid && perpLiveValid;
        next = mode;
        if (mode == PricingMode.BOOTSTRAP && atCompletedEpochOpening && allValid) {
            next = PricingMode.NORMAL_PRICING;
        }
        if (halted || !indexValid) return (next, Admission.NONE);
        if (next == PricingMode.NORMAL_PRICING && allValid) return (next, Admission.LEVERAGED);
        return (next, Admission.BACKED_ONLY);
    }

    function listingValid(uint256 listedAt, uint256 scheduledT, uint256 grace, uint256 voidSecs)
        internal
        pure
        returns (bool)
    {
        return scheduledT >= listedAt + MIN_LISTING_HORIZON && scheduledT + grace <= listedAt + voidSecs;
    }

    function invalidWindow(uint256 scheduledT) internal pure returns (uint256 start, uint256 end) {
        return (scheduledT - INVALID_WINDOW, scheduledT);
    }

    /// @notice Early INVALID waits for T; the 0.5 fallback only for listings that disclosed it and
    ///         only at/after T + grace; legacy listings are BLOCKED.
    function invalidReadiness(
        uint256 nowTs,
        uint256 scheduledT,
        bool windowComplete,
        bool fallbackListed,
        uint256 grace
    ) internal pure returns (InvalidReadiness) {
        if (nowTs < scheduledT) return InvalidReadiness.NOT_YET;
        if (windowComplete) return InvalidReadiness.CAPTURE_TWAP;
        if (!fallbackListed) return InvalidReadiness.BLOCKED;
        return nowTs >= scheduledT + grace ? InvalidReadiness.CAPTURE_FALLBACK : InvalidReadiness.WAIT_GRACE;
    }

    /// @notice UNSET accepts; the same outcome is idempotent; a different outcome reverts.
    function acceptFinality(MathTypes.FinalOutcome stored, MathTypes.FinalOutcome incoming)
        internal
        pure
        returns (MathTypes.FinalOutcome, bool newlyAccepted)
    {
        if (incoming == MathTypes.FinalOutcome.UNSET) revert BadOutcome();
        if (stored == MathTypes.FinalOutcome.UNSET) return (incoming, true);
        if (stored == incoming) return (stored, false);
        revert ConflictingFinalOutcome();
    }

    /// @notice Oracle binary Y (0 = NO, 1 = YES) to the engine-local outcome; other values revert.
    function outcomeFromY(uint8 y) internal pure returns (MathTypes.FinalOutcome) {
        if (y == 0) return MathTypes.FinalOutcome.NO;
        if (y == 1) return MathTypes.FinalOutcome.YES;
        revert BadOutcome();
    }

    function claimsStatus(
        MathTypes.FinalOutcome finality,
        bool priceReady,
        bool snapshotComplete,
        bool payoutComplete,
        bool liabilitiesCovered
    ) internal pure returns (ClaimsStatus) {
        if (finality == MathTypes.FinalOutcome.UNSET) return ClaimsStatus.AWAITING_OUTCOME;
        if (!priceReady) return ClaimsStatus.ORACLE_FINAL_PRICE_PENDING;
        if (!snapshotComplete || !payoutComplete) return ClaimsStatus.ORACLE_FINAL_PREPARING;
        if (!liabilitiesCovered) return ClaimsStatus.RECOVERY_REQUIRED;
        return ClaimsStatus.CLAIMABLE;
    }
}
