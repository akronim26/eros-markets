// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

// PROVISIONAL B-lane stand-in for Person A's A001 `contracts/src/math/MathTypes.sol`.
// Contains only the spec §5.3 / §7.2 / §8.1 names the B libraries need, spelled exactly as the
// spec. Delete at merge and repoint imports to A's MathTypes (docs/merge/B-assumptions.md S-3).

uint256 constant Q = 1e18; // one USDC atom = 1e18 Q
uint256 constant WAD = 1e18;
uint256 constant PAYOFF_Q_PER_LOT = 1000 * Q; // one winning lot pays 1,000 atoms
uint256 constant LOTS_PER_CLAIM = 1000;
uint256 constant Q_PER_USDC = 1e24;
uint16 constant MIN_TICK = 1;
uint16 constant MAX_TICK = 999;
uint256 constant MAX_ABS_POSITION_LOTS = 1 << 40;

enum Side {
    BUY,
    SELL
}

enum Stage {
    TRADING,
    BACKING_GRACE,
    BACKING_FLOOR,
    REDUCE_ONLY,
    HALTED,
    CLAIMS_READY
}

enum AccountingState {
    READY,
    ROLLOVER_SWEEP,
    FLOOR_SWEEP,
    HALT_SWEEP
}

enum PricingMode {
    BOOTSTRAP,
    NORMAL_PRICING
}

/// @dev Engine-local; never ABI-cast from the oracle's {NONE, YES, NO, INVALID}.
enum FinalOutcome {
    UNSET,
    NO,
    YES,
    INVALID
}

enum ClearingPhase {
    LIVE,
    HALTED,
    PREPARING,
    READY,
    COMPLETE
}

enum AdmissionMode {
    NORMAL,
    VOLUNTARY_REDUCTION,
    FORCED_REDUCTION
}

enum StepStatus {
    FILLED,
    PRUNE_MAKER,
    STOP_TAKER
}

enum RejectCode {
    NONE,
    HALTED,
    BAD_STAGE,
    OUTSIDE_BAND,
    BELOW_MIN_SIZE,
    NO_REDUCIBLE_POSITION,
    MAKER_BELOW_IM,
    MAKER_BELOW_MM,
    TAKER_CAPACITY,
    ACCOUNT_DEFICIT_CAP,
    MARKET_COVERAGE,
    INVALID_PRICE_OR_SIZE,
    STALE_ORDER
}

enum RemovalReason {
    USER_CANCEL,
    EXPIRED,
    STALE_MARKET_EPOCH,
    STALE_ACCOUNT_EPOCH,
    STALE_REDUCE_VERSION,
    SELF_TRADE,
    FAILED_READMISSION,
    FILLED,
    REDUCE_ONLY_EXHAUSTED,
    CROSSED_REMAINDER,
    REPLACED
}
