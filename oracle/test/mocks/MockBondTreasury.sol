// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IBondTreasury} from "../../src/interfaces/IBondTreasury.sol";

/// @title MockBondTreasury
/// @notice Stands in for `BondTreasury` in registry tests (task O11.1): records listing commitments and
///         can be scripted to refuse one, as the real treasury does when ASSERTION is below the total.
contract MockBondTreasury {
    uint256 public available; // scripted ASSERTION balance; type(uint256).max = unlimited
    uint256 public totalCommitted;
    mapping(bytes32 => uint256) public committedListing;
    mapping(bytes32 => bool) public released;

    constructor() {
        available = type(uint256).max;
    }

    function setAvailable(uint256 v) external {
        available = v;
    }

    function commitListing(bytes32 id, uint256 bondAtCap) external {
        if (committedListing[id] != 0) revert IBondTreasury.AlreadyCommitted();
        uint256 need = totalCommitted + bondAtCap;
        if (available < need) revert IBondTreasury.BelowCommitments(need, available);
        committedListing[id] = bondAtCap;
        totalCommitted = need;
    }

    function releaseListing(bytes32 id) external {
        totalCommitted -= committedListing[id];
        committedListing[id] = 0;
        released[id] = true;
    }
}
