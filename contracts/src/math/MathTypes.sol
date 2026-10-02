// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

enum AccountingState {
    READY,
    ROLLOVER_SWEEP,
    FLOOR_SWEEP,
    HALT_SWEEP
}

/// @notice Proposed G0 pure-input contract, risk economics v1.0. No protocol storage.
/// @dev Integer widths do not enforce the narrower economic bounds. Library callers must
///      validate decoded inputs and every posted result. Times are uint64 Unix seconds.
library MathTypes {
    uint256 internal constant Q = 1e18;
    uint256 internal constant WAD = 1e18;
    uint256 internal constant ATOMS_PER_USDC = 1e6;
    uint256 internal constant LOTS_PER_CLAIM = 1000;
    uint256 internal constant WAD_PER_TICK = 1e15;
    uint256 internal constant PAYOFF_Q_PER_LOT = 1000 * Q;
    int128 internal constant MAX_POSITION_LOTS = int128(uint128(1) << 40);
    int256 internal constant CASH_Q_BOUND = int256(uint256(1) << 180);
    uint16 internal constant MIN_TICK = 1;
    uint16 internal constant MAX_TICK = 999;
    uint64 internal constant SECONDS_PER_DAY = 86_400;

    enum Side {
        BUY,
        SELL
    }

    /// @dev Engine-local encoding; never cast an external oracle enum into this enum.
    enum FinalOutcome {
        UNSET,
        NO,
        YES,
        INVALID
    }

    enum OracleOutcome {
        NONE,
        YES,
        NO,
        INVALID
    }

    enum SignedRounding {
        FLOOR,
        CEIL,
        TOWARD_ZERO // Only explicit funding-rate quantization uses this policy.
    }

    struct AccountInput {
        int128 positionLots; // Inclusive absolute bound: 2**40 lots.
        int256 cashQ; // Exclusive absolute bound: 2**180 Q.
        int256 fundingCheckpointQPerLot;
        uint64 orderEpoch;
        uint64 positionVersion;
    }

    /// @dev Economic order input, not the book's packed slot or public order ID.
    struct OrderInput {
        Side side;
        uint16 limitTick;
        uint64 remainingLots; // Nonzero live order quantity, not claims.
        uint256 remainingFeeCapQ;
        uint64 marketOrderEpoch;
        uint64 accountOrderEpoch;
        bool reduceOnly;
        uint64 positionVersion;
    }

    struct FundingInput {
        uint64 epochId; // Nonzero; checked increment before wrap.
        uint64 epochStart;
        uint64 epochEnd;
        uint64 lastAccruedAt;
        uint64 effectiveStopAt;
        int256 fundingFQPerLot;
        int256 rateQPerLotSec; // One quantized signed rate, fixed within the epoch.
        uint256 oiAllLots; // One-sided OI including reserve; not a price or cash value.
        int128 reservePositionLots;
        uint256 remainingBudgetQ; // Authorized cash, not funding-index displacement.
    }

    struct PayoffInput {
        int128 positionLots;
        int256 cashQAtHalt;
        FinalOutcome finalOutcome;
        uint256 settlementPriceWad; // NO=0, YES=WAD, INVALID in [0,WAD].
    }

    error InvalidBinaryOutcome(uint8 y);
    error OutcomeNotFinal();

    /// @notice Convert settle(uint8 Y) explicitly; engine enum ordinals are not Y.
    function fromBinaryY(uint8 y) internal pure returns (FinalOutcome) {
        if (y == 0) return FinalOutcome.NO;
        if (y == 1) return FinalOutcome.YES;
        revert InvalidBinaryOutcome(y);
    }

    /// @notice Explicit mapping from the source oracle's differently ordered enum.
    function fromOracleOutcome(OracleOutcome outcome) internal pure returns (FinalOutcome) {
        if (outcome == OracleOutcome.YES) return FinalOutcome.YES;
        if (outcome == OracleOutcome.NO) return FinalOutcome.NO;
        if (outcome == OracleOutcome.INVALID) return FinalOutcome.INVALID;
        revert OutcomeNotFinal();
    }
}
