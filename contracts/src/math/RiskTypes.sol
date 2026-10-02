// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {MathTypes, AccountingState} from "./MathTypes.sol";

// Person B shared names (spec §4.6, §7.2, §8.1). Unit constants are re-exported from Person A's
// MathTypes (A001), so there is one source of truth for Q / WAD / payoff / tick bounds. `Side` and
// `FinalOutcome` are used directly as `MathTypes.Side` / `MathTypes.FinalOutcome`. Replaces the
// former provisional/MathTypes.sol stand-in (integration, docs/merge/interface-reconciliation.md R-02).

uint256 constant Q = MathTypes.Q; // one USDC atom = 1e18 Q
uint256 constant WAD = MathTypes.WAD;
uint256 constant PAYOFF_Q_PER_LOT = MathTypes.PAYOFF_Q_PER_LOT; // one winning lot pays 1,000 atoms
uint256 constant LOTS_PER_CLAIM = MathTypes.LOTS_PER_CLAIM;
uint256 constant Q_PER_USDC = MathTypes.Q * MathTypes.ATOMS_PER_USDC;
uint16 constant MIN_TICK = MathTypes.MIN_TICK;
uint16 constant MAX_TICK = MathTypes.MAX_TICK;
uint256 constant MAX_ABS_POSITION_LOTS = uint256(1) << 40; // == uint128(MathTypes.MAX_POSITION_LOTS)

enum Stage {
    TRADING,
    BACKING_GRACE,
    BACKING_FLOOR,
    REDUCE_ONLY,
    HALTED,
    CLAIMS_READY
}

enum PricingMode {
    BOOTSTRAP,
    NORMAL_PRICING
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
