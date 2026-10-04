// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {OracleConst} from "../types/OracleTypes.sol";

/// @title VoidBound
/// @notice Lower bound on a market's `voidSecs` (plan §14.2; task O10.4), checked by `createMarket`:
///         `T_L1 + T_L2 + A_max·(T_live + (R_max + 2)·T_round) + (A_max − 1)·(T_r + T_retry) + T_slack`.
/// @dev `T_L1` is the Layer 1 timeout for a feed market and 0 otherwise; `T_live` is the reviewed
///      liveness (the longest); `(R_max + 2)` counts the DVM round a dispute waits to enter plus
///      `R_max + 1` voting rounds. All inputs are seconds except `dvmMaxRolls`. No overflow is possible:
///      every input is at most 64 bits and the result is computed in 256 bits.
library VoidBound {
    struct Inputs {
        bool hasFeed;
        uint32 l1TimeoutSecs; // T_L1 (ignored without a feed)
        uint32 l2DeadlineSecs; // T_L2
        uint64 livenessReviewed; // T_live
        uint8 dvmMaxRolls; // R_max (globals)
        uint32 dvmRoundSecs; // T_round (globals)
        uint32 reviewTargetSecs; // T_r (globals)
        uint32 retryWindowSecs; // T_retry (globals)
        uint32 voidSlackSecs; // T_slack (globals)
    }

    function minVoidSecs(Inputs memory i) internal pure returns (uint256) {
        uint256 aMax = OracleConst.A_MAX;
        uint256 tL1 = i.hasFeed ? i.l1TimeoutSecs : 0;
        uint256 perAttempt = uint256(i.livenessReviewed) + (uint256(i.dvmMaxRolls) + 2) * i.dvmRoundSecs;
        uint256 perRetry = uint256(i.reviewTargetSecs) + i.retryWindowSecs;
        return tL1 + i.l2DeadlineSecs + aMax * perAttempt + (aMax - 1) * perRetry + i.voidSlackSecs;
    }
}
