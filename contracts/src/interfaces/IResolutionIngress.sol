// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {ClearingPhase} from "../math/RiskTypes.sol";
import {MathTypes} from "../math/MathTypes.sol";

/// @notice Engine halt snapshot (spec §8.1). `snapshotId` is an identifier, not a Merkle
///         commitment to every account. `oiHaltLots` is one-sided OI in lots incl. the reserve.
struct HaltView {
    bool halted;
    uint64 economicHaltAt;
    uint64 haltRecordedAt;
    uint64 frozenAccountCount;
    uint64 frozenBookEpoch;
    uint256 oiHaltLots;
    int256 fundingIndexAtHalt;
    uint64 accountingEpochAtHalt;
    uint64 accrualCutoff;
    bytes32 premiumTariffHash;
    bytes32 snapshotId;
}

/// @notice Settlement status for the oracle team and UI (spec §8.1). UIs must enable payouts only
///         from `claimsEnabled`, never from oracle finality alone.
struct SettlementView {
    ClearingPhase phase;
    bool halted;
    MathTypes.FinalOutcome finalOutcome;
    bool oracleFinalityAccepted;
    bool invalidPriceReady;
    uint256 settlementPriceE18;
    bytes32 snapshotId;
    uint64 snapshotCursor;
    uint64 payoutCursor;
    uint64 accountCount;
    uint256 totalTraderPayoutAtoms;
    uint256 totalDeficitQ;
    bool claimsEnabled;
    bool accountingComplete;
    bool recoveryRequired;
}

/// @title IResolutionEngine (IResolutionIngress)
/// @notice CP-ORACLE boundary, spec §8.1: the only calls the pinned ResolutionOracle can make.
///         `settle(Y)` takes Y exactly 0 (NO) or 1 (YES); every other value reverts. INVALID and
///         Voided both call `settleInvalid()`; the oracle never supplies a price.
interface IResolutionEngine {
    function halt() external returns (HaltView memory snapshot);

    function settle(uint8 Y) external returns (bool newlyAccepted);

    function settleInvalid() external returns (bool newlyAccepted);

    /// @notice Permissionless at/after T; chooses no outcome (selected integration rule).
    function materializeScheduledHalt() external returns (HaltView memory snapshot);

    function getHaltSnapshot() external view returns (HaltView memory);

    function getSettlementStatus() external view returns (SettlementView memory);
}

/// @title OracleOutcomeMap
/// @notice Explicit mapping from the oracle team's source enum {NONE, YES, NO, INVALID, VOIDED}
///         to the engine call and the engine-local FinalOutcome. Never an ABI cast.
library OracleOutcomeMap {
    error NoEngineCall();

    /// @dev Oracle source enum values (external team): NONE = 0, YES = 1, NO = 2, INVALID = 3,
    ///      VOIDED = 4. Voided is a reason for INVALID, not a fourth payout.
    uint8 internal constant ORACLE_NONE = 0;
    uint8 internal constant ORACLE_YES = 1;
    uint8 internal constant ORACLE_NO = 2;
    uint8 internal constant ORACLE_INVALID = 3;
    uint8 internal constant ORACLE_VOIDED = 4;

    enum EngineCall {
        SETTLE_BINARY,
        SETTLE_INVALID
    }

    /// @return call which engine entry point; y the binary payoff argument (only for SETTLE_BINARY)
    function engineCallFor(uint8 oracleOutcome) internal pure returns (EngineCall call, uint8 y) {
        if (oracleOutcome == ORACLE_YES) return (EngineCall.SETTLE_BINARY, 1);
        if (oracleOutcome == ORACLE_NO) return (EngineCall.SETTLE_BINARY, 0);
        if (oracleOutcome == ORACLE_INVALID || oracleOutcome == ORACLE_VOIDED) {
            return (EngineCall.SETTLE_INVALID, 0);
        }
        revert NoEngineCall();
    }

    /// @notice Binary payoff Y -> engine-local outcome (YES = 2, NO = 1 in FinalOutcome).
    function localOutcome(uint8 y) internal pure returns (MathTypes.FinalOutcome) {
        if (y == 1) return MathTypes.FinalOutcome.YES;
        if (y == 0) return MathTypes.FinalOutcome.NO;
        revert NoEngineCall();
    }
}
