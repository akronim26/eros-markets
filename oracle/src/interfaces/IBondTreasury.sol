// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Ledger} from "../types/OracleTypes.sol";

interface IBondTreasury {
    error Unauthorized();
    error InsufficientLedger(Ledger ledger, uint256 need, uint256 have);
    error BelowCommitments(uint256 need, uint256 have);
    error PerMarketCapExceeded();
    error TooManyOpenDisputes();
    error NoLiveAssertion();
    error AlreadyCommitted();

    event Deposited(Ledger indexed ledger, address indexed from, uint256 amount);
    event ListingCommitted(bytes32 indexed id, uint256 amount);
    event ListingReleased(bytes32 indexed id, uint256 amount);
    event AssertionFunded(bytes32 indexed id, uint8 attempt, address venue, uint256 bond);
    event BondReturned(bytes32 indexed id, uint8 attempt, uint256 amount);
    event BondLost(bytes32 indexed id, uint8 attempt, uint256 amount);
    event BondStuck(bytes32 indexed id, uint8 attempt, uint256 amount);
    event DisputeFunded(bytes32 indexed id, bytes32 indexed assertionId, uint256 bond);
    event DisputeClosed(bytes32 indexed assertionId);
    event RewardPaid(bytes32 indexed id, address indexed proposer, uint256 amount);
    event RewardOwed(bytes32 indexed id, address indexed proposer, uint256 amount);
    event OwedClaimed(address indexed proposer, uint256 amount);
    event Skimmed(uint256 amount);
    event Withdrawn(Ledger indexed ledger, address indexed to, uint256 amount);
    event LimitsSet(uint256 maxPerMarket, uint32 maxOpenDisputes);

    function deposit(Ledger ledger, uint256 amount) external; // anyone

    // MarketRegistry only
    function commitListing(bytes32 id, uint256 bondAtCap) external; // ASSERTION >= totalCommitted + bondAtCap

    // ResolutionOracle only
    function fundAssertion(bytes32 id, uint8 attempt, address venue, uint256 bond) external;
    function onBondReturned(bytes32 id, uint8 attempt) external;
    function onBondLost(bytes32 id, uint8 attempt) external;
    function markStuck(bytes32 id, uint8 attempt) external;
    function payProposerReward(bytes32 id, address proposer, uint256 amount) external returns (bool paid); // never reverts on shortage
    function releaseListing(bytes32 id) external;

    // pinned watchdog of the market (oracle.watchdogOf(id))
    function disputeViaVenue(bytes32 id) external;
    // anyone; only for a dispute disputeViaVenue recorded (else false). Closes once the venue shows it settled,
    // or once its market is Final with VOID_DEADLINE; decrements openDisputes; a second call returns false
    function closeDispute(bytes32 assertionId) external returns (bool closed);

    function claimOwed() external;
    function skim() external returns (uint256 credited); // anyone
    function withdraw(Ledger ledger, address to, uint256 amount) external; // Timelock
    function setLimits(uint256 maxPerMarket, uint32 maxOpenDisputes) external; // Timelock

    function balanceOf(Ledger ledger) external view returns (uint256);
    function outstanding(bytes32 id, uint8 attempt) external view returns (uint256);
    function committedListing(bytes32 id) external view returns (uint256);
    function totalCommitted() external view returns (uint256);
    function owed(address proposer) external view returns (uint256);
    function openDisputes() external view returns (uint32);
    function fundedTotal(bytes32 id) external view returns (uint256); // sum of bonds funded for the market, <= maxPerMarket
    function maxPerMarket() external view returns (uint256);
    function maxOpenDisputes() external view returns (uint32);
}
