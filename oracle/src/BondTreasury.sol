// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {ReentrancyGuard} from "solady/utils/ReentrancyGuard.sol";
import {SafeTransferLib} from "solady/utils/SafeTransferLib.sol";
import {Ledger, Resolution, RState, FinalReason} from "./types/OracleTypes.sol";
import {IBondTreasury} from "./interfaces/IBondTreasury.sol";
import {IResolutionOracle} from "./interfaces/IResolutionOracle.sol";
import {IAssertionVenue} from "./interfaces/IAssertionVenue.sol";

interface IERC20Transfer {
    function transfer(address to, uint256 amount) external returns (bool);
}

/// @title BondTreasury
/// @notice Holds the oracle's USDC in three separate sub-ledgers: ASSERTION (team assertion bonds),
///         WATCHDOG_FLOAT (watchdog disputes) and PROPOSER_REWARD (permissionless proposer rewards)
///         (plan §6.6, Appendix C.1, C.5). Funded from the protocol fee share; it never touches market
///         reserves or the CollateralVault. Not upgradeable; governance is the Timelock.
/// @dev Tasks O12.1 (ledgers, deposits, listing commitments, withdraw, limits), O12.2 (bond flows and
///      proposer rewards) and O12.3 (watchdog disputes, closeDispute, skim).
///
///      Bonds are keyed by `(marketId, attempt)`, the 0-based assertion index (ADJ-27). `fundAssertion`
///      debits ASSERTION, approves the market's venue for exactly the bond (the venue pulls it), and adds
///      to `outstanding` and `totalOutstanding`; a repeated attempt adds up rather than overwriting.
///      `onBondReturned` credits ASSERTION back (the venue has already paid the treasury as asserter);
///      `onBondLost` and `markStuck` only clear the record. All three are no-ops when nothing is
///      outstanding, and `payProposerReward` never reverts: the oracle calls them inside `_final`,
///      `_reject` and `voidMarket`, and the treasury must never block a market (ORC-9).
///
///      Listing commitments (audit EM-27): `createMarket` commits each market's bond at its OI cap, and
///      the ASSERTION ledger must cover every open commitment at once. Withdrawals never take ASSERTION
///      below `totalCommitted`. `releaseListing` is a no-op for an id with no open commitment, because
///      the oracle calls it inside `_final` and the treasury must never block finalization (ORC-9).
///
///      Watchdog disputes: only the market's pinned watchdog (`oracle.watchdogOf(id)`, 0 once revoked)
///      can spend WATCHDOG_FLOAT, one dispute per live assertion, at most `maxOpenDisputes` at once. The
///      bond is the venue's own figure for the assertion (exactly what the venue pulls), and the
///      assertion must still be disputable on the venue (exists, unsettled, undisputed, liveness
///      running). Each dispute is recorded by assertionId until `closeDispute` sees it settled on the
///      venue, or its market Final with VOID_DEADLINE (a never-answered vote never pays).
///
///      Solvency (ORC-14): a deposit credits the balance increase actually received, so
///      `usdc.balanceOf(this) ≥ Σ ledgers` holds for any token. `skim` credits WATCHDOG_FLOAT with only
///      `balance − Σ ledgers − totalOutstanding − openDisputeBonds` when positive: money an in-flight
///      bond return will book is never credited twice, and dispute winnings are credited once no bond
///      that could still claim them is out.
contract BondTreasury is IBondTreasury, ReentrancyGuard {
    using SafeTransferLib for address;

    struct DisputeRecord {
        bytes32 marketId;
        address venue; // 0 = no recorded dispute
        uint256 bond;
    }

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
    mapping(bytes32 marketId => mapping(uint8 attempt => uint256)) public outstanding;
    mapping(bytes32 marketId => uint256) public fundedTotal; // every bond ever funded, <= maxPerMarket
    uint256 public totalOutstanding; // Σ outstanding, used by skim (O12.3)
    mapping(address proposer => uint256) public owed; // reward IOUs
    uint256 public maxPerMarket; // 0 until setLimits
    uint32 public maxOpenDisputes; // 0 until setLimits
    uint32 public openDisputes;
    uint256 public openDisputeBonds; // Σ bonds of the recorded open disputes, used by skim
    mapping(bytes32 assertionId => DisputeRecord) public disputes;

    modifier onlyGovernance() {
        if (msg.sender != governance) revert Unauthorized();
        _;
    }

    modifier onlyRegistry() {
        if (msg.sender != registry) revert Unauthorized();
        _;
    }

    modifier onlyOracle() {
        if (msg.sender != oracle) revert Unauthorized();
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
        emit Deposited(ledger, msg.sender, received);
    }

    /// @notice Pays the caller's whole reward IOU once PROPOSER_REWARD covers it; nothing owed is a no-op.
    function claimOwed() external nonReentrant {
        uint256 amount = owed[msg.sender];
        if (amount == 0) return;
        uint256 have = _ledgers[Ledger.PROPOSER_REWARD];
        if (have < amount) revert InsufficientLedger(Ledger.PROPOSER_REWARD, amount, have);
        owed[msg.sender] = 0;
        _ledgers[Ledger.PROPOSER_REWARD] = have - amount;
        usdc.safeTransfer(msg.sender, amount);
        emit OwedClaimed(msg.sender, amount);
    }

    // ------------------------------------------------------------------ MarketRegistry

    /// @notice Commits a new market's bond at its OI cap: ASSERTION must cover every open commitment
    ///         plus this one (§6.3 step 7, §6.6).
    function commitListing(bytes32 id, uint256 bondAtCap) external onlyRegistry nonReentrant {
        if (_commitment[id] != Commitment.NONE) revert AlreadyCommitted();
        uint256 need = totalCommitted + bondAtCap;
        uint256 have = _ledgers[Ledger.ASSERTION];
        if (have < need) revert BelowCommitments(need, have);
        _commitment[id] = Commitment.OPEN;
        committedListing[id] = bondAtCap;
        totalCommitted = need;
        emit ListingCommitted(id, bondAtCap);
    }

    // ------------------------------------------------------------------ ResolutionOracle

    /// @notice Frees the market's listing commitment (called in `_final`). No-op without an open one.
    function releaseListing(bytes32 id) external onlyOracle nonReentrant {
        if (_commitment[id] != Commitment.OPEN) return;
        uint256 amount = committedListing[id];
        _commitment[id] = Commitment.RELEASED;
        committedListing[id] = 0;
        totalCommitted -= amount;
        emit ListingReleased(id, amount);
    }

    /// @notice Funds a team-path assertion: debits ASSERTION and approves `venue` (the market's pinned
    ///         venue, passed by the oracle) for exactly `bond`; the venue pulls it in the same transaction.
    function fundAssertion(bytes32 id, uint8 attempt, address venue, uint256 bond) external onlyOracle nonReentrant {
        uint256 have = _ledgers[Ledger.ASSERTION];
        if (have < bond) revert InsufficientLedger(Ledger.ASSERTION, bond, have);
        uint256 funded = fundedTotal[id] + bond;
        if (funded > maxPerMarket) revert PerMarketCapExceeded();
        _ledgers[Ledger.ASSERTION] = have - bond;
        outstanding[id][attempt] += bond;
        fundedTotal[id] = funded;
        totalOutstanding += bond;
        usdc.safeApprove(venue, bond);
        emit AssertionFunded(id, attempt, venue, bond);
    }

    /// @notice The assertion settled true: the venue paid the bond back to the treasury (the asserter),
    ///         so ASSERTION is credited with it.
    function onBondReturned(bytes32 id, uint8 attempt) external onlyOracle nonReentrant {
        uint256 amount = _clearOutstanding(id, attempt);
        if (amount == 0) return;
        _ledgers[Ledger.ASSERTION] += amount;
        emit BondReturned(id, attempt, amount);
    }

    /// @notice The assertion settled false: the bond went to the disputer. Clears the record, no credit.
    function onBondLost(bytes32 id, uint8 attempt) external onlyOracle nonReentrant {
        uint256 amount = _clearOutstanding(id, attempt);
        if (amount != 0) emit BondLost(id, attempt, amount);
    }

    /// @notice The market voided with this bond still live. Clears the record, no credit; if the bond
    ///         ever comes back it arrives as plain USDC and `skim` credits it (O12.3).
    function markStuck(bytes32 id, uint8 attempt) external onlyOracle nonReentrant {
        uint256 amount = _clearOutstanding(id, attempt);
        if (amount != 0) emit BondStuck(id, attempt, amount);
    }

    /// @notice Pays a Final permissionless proposer's reward from PROPOSER_REWARD. Never reverts: when the
    ///         ledger is short or the transfer fails, the reward is recorded as an IOU (`owed`) instead.
    /// @return paid true when the reward was transferred (or is zero).
    function payProposerReward(bytes32 id, address proposer, uint256 amount)
        external
        onlyOracle
        nonReentrant
        returns (bool paid)
    {
        if (amount == 0) return true;
        uint256 have = _ledgers[Ledger.PROPOSER_REWARD];
        if (have >= amount) {
            _ledgers[Ledger.PROPOSER_REWARD] = have - amount;
            if (_tryTransfer(proposer, amount)) {
                emit RewardPaid(id, proposer, amount);
                return true;
            }
            _ledgers[Ledger.PROPOSER_REWARD] = have;
        }
        owed[proposer] += amount;
        emit RewardOwed(id, proposer, amount);
        return false;
    }

    // ------------------------------------------------------------------ watchdog disputes

    /// @notice The market's pinned watchdog disputes its live assertion with WATCHDOG_FLOAT; the venue pulls
    ///         the bond and any winnings return to the treasury as plain USDC (credited by `skim`).
    function disputeViaVenue(bytes32 id) external nonReentrant {
        if (msg.sender != IResolutionOracle(oracle).watchdogOf(id)) revert Unauthorized();
        Resolution memory r = IResolutionOracle(oracle).getResolution(id);
        if (r.assertionId == 0) revert NoLiveAssertion();
        IAssertionVenue.AssertionStatus memory st = IAssertionVenue(r.assertionVenue).statusOf(r.assertionId);
        if (!st.exists || st.settled || st.disputed || block.timestamp >= st.expiresAt) revert NoLiveAssertion();
        if (openDisputes >= maxOpenDisputes) revert TooManyOpenDisputes();
        uint256 have = _ledgers[Ledger.WATCHDOG_FLOAT];
        if (have < st.bond) revert InsufficientLedger(Ledger.WATCHDOG_FLOAT, st.bond, have);
        _ledgers[Ledger.WATCHDOG_FLOAT] = have - st.bond;
        ++openDisputes;
        openDisputeBonds += st.bond;
        disputes[r.assertionId] = DisputeRecord(id, r.assertionVenue, st.bond);
        usdc.safeApprove(r.assertionVenue, st.bond);
        IAssertionVenue(r.assertionVenue).disputeFor(r.assertionId, address(this), address(this));
        emit DisputeFunded(id, r.assertionId, st.bond);
    }

    /// @notice Anyone. Closes a dispute `disputeViaVenue` recorded once the venue shows the assertion
    ///         settled, or once its market is Final with VOID_DEADLINE (the bond is written off). Returns
    ///         false for anything else, including a second call.
    function closeDispute(bytes32 assertionId) external nonReentrant returns (bool closed) {
        DisputeRecord memory d = disputes[assertionId];
        if (d.venue == address(0)) return false;
        if (!IAssertionVenue(d.venue).statusOf(assertionId).settled) {
            Resolution memory r = IResolutionOracle(oracle).getResolution(d.marketId);
            if (r.state != RState.Final || r.finalReason != FinalReason.VOID_DEADLINE) return false;
        }
        delete disputes[assertionId];
        --openDisputes;
        openDisputeBonds -= d.bond;
        emit DisputeClosed(assertionId);
        return true;
    }

    /// @notice Anyone. Credits WATCHDOG_FLOAT with USDC no ledger, outstanding bond or open dispute
    ///         accounts for (dispute winnings, donations). Returns 0 instead of reverting when there is none.
    function skim() external nonReentrant returns (uint256 credited) {
        uint256 held = _ledgers[Ledger.ASSERTION] + _ledgers[Ledger.WATCHDOG_FLOAT] + _ledgers[Ledger.PROPOSER_REWARD]
            + totalOutstanding + openDisputeBonds;
        uint256 balance = usdc.balanceOf(address(this));
        if (balance <= held) return 0;
        credited = balance - held;
        _ledgers[Ledger.WATCHDOG_FLOAT] += credited;
        emit Skimmed(credited);
    }

    // ------------------------------------------------------------------ governance (Timelock)

    /// @notice Pays out of one ledger: ASSERTION only down to `totalCommitted`, the others down to 0.
    function withdraw(Ledger ledger, address to, uint256 amount) external onlyGovernance nonReentrant {
        uint256 have = _ledgers[ledger];
        if (amount > have) revert InsufficientLedger(ledger, amount, have);
        if (ledger == Ledger.ASSERTION && have - amount < totalCommitted) {
            revert BelowCommitments(totalCommitted + amount, have);
        }
        _ledgers[ledger] = have - amount;
        usdc.safeTransfer(to, amount);
        emit Withdrawn(ledger, to, amount);
    }

    /// @notice Production start: `maxPerMarket` = 3 × the bond at the largest OI cap, `maxOpenDisputes` = 20
    ///         (§6.6, §14.1). Both start at 0, so bonds and disputes are refused until this is called.
    function setLimits(uint256 maxPerMarket_, uint32 maxOpenDisputes_) external onlyGovernance nonReentrant {
        maxPerMarket = maxPerMarket_;
        maxOpenDisputes = maxOpenDisputes_;
        emit LimitsSet(maxPerMarket_, maxOpenDisputes_);
    }

    // ------------------------------------------------------------------ internals

    function _clearOutstanding(bytes32 id, uint8 attempt) internal returns (uint256 amount) {
        amount = outstanding[id][attempt];
        if (amount == 0) return 0;
        outstanding[id][attempt] = 0;
        totalOutstanding -= amount;
    }

    /// @dev ERC-20 `transfer` that reports failure instead of reverting (a revert, `false`, or malformed
    ///      return data all count as failure).
    function _tryTransfer(address to, uint256 amount) internal returns (bool) {
        (bool ok, bytes memory ret) = usdc.call(abi.encodeWithSelector(IERC20Transfer.transfer.selector, to, amount));
        if (!ok) return false;
        if (ret.length == 0) return usdc.code.length != 0;
        return ret.length == 32 && abi.decode(ret, (uint256)) == 1;
    }

    // ------------------------------------------------------------------ views

    function balanceOf(Ledger ledger) external view returns (uint256) {
        return _ledgers[ledger];
    }
}
