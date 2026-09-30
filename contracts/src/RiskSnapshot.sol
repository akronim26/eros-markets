// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

/// @notice Risk inputs Clearing loads once per taker order (in `_takerStart`) and reads in every
///         later hook of that order (spec §9.6: "copy a snapshot into memory ... every check in
///         the transaction uses this snapshot").
/// @dev Owned by Clearing (R2): add, remove or retype fields here freely. Book only carries it in
///      `Ctx` and never reads it, so changes here need no change in Book. Expected additions: the
///      taker's account, gates, open interest and shortfall aggregates (mutable ones must reflect
///      earlier fills of the same order).
struct RiskSnapshot {
    uint256 index; // I, fast index
    uint256 slowIndex; // I_S
    uint256 mark; // q
    uint8 stage; // market stage
    uint8 tier; // leverage tier
}
