// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {ReentrancyGuard} from "solady/utils/ReentrancyGuard.sol";
import {SafeTransferLib} from "solady/utils/SafeTransferLib.sol";
import {Ledger} from "./types/OracleTypes.sol";
import {IBondTreasury} from "./interfaces/IBondTreasury.sol";

/// @title BondTreasury
/// @notice Holds the oracle's USDC in three separate sub-ledgers: ASSERTION (team assertion bonds),
///         WATCHDOG_FLOAT (watchdog disputes) and PROPOSER_REWARD (permissionless proposer rewards)
///         (plan §6.6, Appendix C.1, C.5). Funded from the protocol fee share; it never touches market
///         reserves or the CollateralVault. Not upgradeable; governance is the Timelock.
/// @dev Task O12.1 builds the ledgers, deposits, listing commitments, withdraw and limits; the bond flows
///      (O12.2) and watchdog disputes (O12.3) follow, and O12.3 declares `is IBondTreasury`. Until then
///      errors and events are the C.5 declarations, used by qualified name.
///
///      Listing commitments (audit EM-27): `createMarket` commits each market's bond at its OI cap, and
///      the ASSERTION ledger must cover every open commitment at once. Withdrawals never take ASSERTION
///      below `totalCommitted`. `releaseListing` is a no-op for an id with no open commitment, because
///      the oracle calls it inside `_final` and the treasury must never block finalization (ORC-9).
///
///      Solvency (ORC-14): a deposit credits the balance increase actually received, so
///      `usdc.balanceOf(this) ≥ Σ ledgers` holds for any token.
contract BondTreasury is ReentrancyGuard {
    using SafeTransferLib for address;

    enum Commitment {
        NONE,
        OPEN,
        RELEASED
    }

    address public immutable usdc;
    address public immutable oracle; // ResolutionOracle
    address public immutable registry; // MarketRegistry
    address public immutable governance; // Timelock

    mapping(Ledger => uint256) internal _ledgers;
    mapping(bytes32 marketId => uint256) public committedListing; // open commitment, 0 once released
    mapping(bytes32 marketId => Commitment) internal _commitment;
    uint256 public totalCommitted;
    uint256 public maxPerMarket; // 0 until setLimits
    uint32 public maxOpenDisputes; // 0 until setLimits

    modifier onlyGovernance() {
        if (msg.sender != governance) revert IBondTreasury.Unauthorized();
        _;
    }

    modifier onlyRegistry() {
        if (msg.sender != registry) revert IBondTreasury.Unauthorized();
        _;
    }

    modifier onlyOracle() {
        if (msg.sender != oracle) revert IBondTreasury.Unauthorized();
        _;
    }

    constructor(address usdc_, address oracle_, address registry_, address governance_) {
        usdc = usdc_;
        oracle = oracle_;
        registry = registry_;
        governance = governance_;
    }

    // ------------------------------------------------------------------ anyone

    /// @notice Pulls `amount` USDC from the caller (the protocol fee router, or anyone) and credits
    ///         `ledger` with what actually arrived.
    function deposit(Ledger ledger, uint256 amount) external nonReentrant {
        uint256 before = usdc.balanceOf(address(this));
        usdc.safeTransferFrom(msg.sender, address(this), amount);
        uint256 received = usdc.balanceOf(address(this)) - before;
        _ledgers[ledger] += received;
        emit IBondTreasury.Deposited(ledger, msg.sender, received);
    }

    // ------------------------------------------------------------------ MarketRegistry

    /// @notice Commits a new market's bond at its OI cap: ASSERTION must cover every open commitment
    ///         plus this one (§6.3 step 7, §6.6).
    function commitListing(bytes32 id, uint256 bondAtCap) external onlyRegistry nonReentrant {
        if (_commitment[id] != Commitment.NONE) revert IBondTreasury.AlreadyCommitted();
        uint256 need = totalCommitted + bondAtCap;
        uint256 have = _ledgers[Ledger.ASSERTION];
        if (have < need) revert IBondTreasury.BelowCommitments(need, have);
        _commitment[id] = Commitment.OPEN;
        committedListing[id] = bondAtCap;
        totalCommitted = need;
        emit IBondTreasury.ListingCommitted(id, bondAtCap);
    }

    // ------------------------------------------------------------------ ResolutionOracle

    /// @notice Frees the market's listing commitment (called in `_final`). No-op without an open one.
    function releaseListing(bytes32 id) external onlyOracle nonReentrant {
        if (_commitment[id] != Commitment.OPEN) return;
        uint256 amount = committedListing[id];
        _commitment[id] = Commitment.RELEASED;
        committedListing[id] = 0;
        totalCommitted -= amount;
        emit IBondTreasury.ListingReleased(id, amount);
    }

    // ------------------------------------------------------------------ governance (Timelock)

    /// @notice Pays out of one ledger: ASSERTION only down to `totalCommitted`, the others down to 0.
    function withdraw(Ledger ledger, address to, uint256 amount) external onlyGovernance nonReentrant {
        uint256 have = _ledgers[ledger];
        if (amount > have) revert IBondTreasury.InsufficientLedger(ledger, amount, have);
        if (ledger == Ledger.ASSERTION && have - amount < totalCommitted) {
            revert IBondTreasury.BelowCommitments(totalCommitted + amount, have);
        }
        _ledgers[ledger] = have - amount;
        usdc.safeTransfer(to, amount);
        emit IBondTreasury.Withdrawn(ledger, to, amount);
    }

    /// @notice Production start: `maxPerMarket` = 3 × the bond at the largest OI cap, `maxOpenDisputes` = 20
    ///         (§6.6, §14.1). Both start at 0, so bonds and disputes are refused until this is called.
    function setLimits(uint256 maxPerMarket_, uint32 maxOpenDisputes_) external onlyGovernance nonReentrant {
        maxPerMarket = maxPerMarket_;
        maxOpenDisputes = maxOpenDisputes_;
        emit IBondTreasury.LimitsSet(maxPerMarket_, maxOpenDisputes_);
    }

    // ------------------------------------------------------------------ views

    function balanceOf(Ledger ledger) external view returns (uint256) {
        return _ledgers[ledger];
    }
}
