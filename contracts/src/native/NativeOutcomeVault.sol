// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {ReentrancyGuard} from "solady/utils/ReentrancyGuard.sol";
import {SafeTransferLib} from "solady/utils/SafeTransferLib.sol";
import {IMarketConfig} from "../interfaces/IMarketConfig.sol";
import {IResolutionEngine, SettlementView} from "../interfaces/IResolutionIngress.sol";
import {MathTypes} from "../math/MathTypes.sol";
import {INativeRegistryReads, RegistryMarketCore} from "./INativeMarketReads.sol";
import {OutcomeToken} from "./OutcomeToken.sol";

interface INativeCollateral {
    function decimals() external view returns (uint8);
    function balanceOf(address) external view returns (uint256);
}

/// @title NativeOutcomeVault
/// @notice Fully backed complete-set issuance for one native binary event (NM-C02..C06).
///         One collateral atom backs exactly one YES atom plus one NO atom.
///
///         Lifecycle:
///           1. constructor: pin (registry, marketId, collateral, rulesHash, T, cap); create YES/NO.
///           2. `bindMarket()`: permissionless, once: read the registry-selected engine and verify it
///              lists this exact event; no caller-chosen engine.
///           3. `split` (before economic halt) / `merge` (until resolution latch).
///           4. `syncResolution()`: permissionless, once: copy the bound engine's final payout value.
///           5. `redeem`: burn caller-owned YES/NO for `floor((y·p + n·(1e18−p)) / 1e18)` atoms.
///
///         Invariants: before resolution YES.supply == NO.supply == outstandingSets <= custody.
///         After resolution, total paid <= outstandingSets at resolution. Donations never create
///         claims; rounding dust stays in the vault (no sweep authority exists).
/// @dev The native custody is separate from `CollateralVault`, perp reserves, venue margin and
///      oracle bonds. The vault never reads a perp account or waits for perp payout paging.
contract NativeOutcomeVault is ReentrancyGuard {
    using SafeTransferLib for address;

    uint256 internal constant WAD = 1e18;
    /// @dev Keeps `amount * WAD` sums far from overflow; ~1e30 atoms = 1e24 whole claims.
    uint256 internal constant MAX_ISSUANCE_CAP = 1e30;

    error BadConfig();
    error AlreadyBound();
    error NotBound();
    error NotListed();
    error BindingMismatch(uint8 field);
    error IssuanceClosed();
    error CapExceeded();
    error ZeroAmount();
    error ZeroReceiver();
    error ShortTransfer();
    error Resolved();
    error NotResolved();
    error FinalityNotAccepted();
    error InvalidPricePending();
    error BadSettlementPrice();

    event Bound(address indexed engine, address indexed resolutionAuthority, bytes32 listingHash);
    event Split(address indexed payer, address indexed receiver, uint256 atoms);
    event Merged(address indexed owner, address indexed receiver, uint256 atoms);
    event ResolutionSynced(
        MathTypes.FinalOutcome outcome, uint256 payoutYesWad, bytes32 snapshotId, uint256 outstandingSets
    );
    event Redeemed(address indexed owner, address indexed receiver, uint256 yesAtoms, uint256 noAtoms, uint256 paid);

    // ---- immutable binding inputs (NM-A03 / NM-C02)
    address public immutable registry;
    bytes32 public immutable marketId;
    address public immutable collateral;
    bytes32 public immutable rulesHash;
    uint64 public immutable scheduledT;
    uint256 public immutable issuanceCap;
    OutcomeToken public immutable yes;
    OutcomeToken public immutable no;

    // ---- one-time latches
    address public engine;
    bool public resolved;
    MathTypes.FinalOutcome public finalOutcome;
    uint256 public payoutYesWad;

    // ---- accounting
    /// @notice Complete sets currently backed (frozen at the resolution latch).
    uint256 public outstandingSets;
    /// @notice Collateral atoms paid by `redeem` (only after resolution).
    uint256 public totalRedeemedAtoms;

    constructor(
        address registry_,
        bytes32 marketId_,
        address collateral_,
        bytes32 rulesHash_,
        uint64 scheduledT_,
        uint256 issuanceCap_,
        string memory yesSymbol,
        string memory noSymbol
    ) {
        if (
            registry_ == address(0) || marketId_ == bytes32(0) || collateral_ == address(0)
                || rulesHash_ == bytes32(0) || scheduledT_ <= block.timestamp || issuanceCap_ == 0
                || issuanceCap_ > MAX_ISSUANCE_CAP || INativeCollateral(collateral_).decimals() != 6
        ) revert BadConfig();
        registry = registry_;
        marketId = marketId_;
        collateral = collateral_;
        rulesHash = rulesHash_;
        scheduledT = scheduledT_;
        issuanceCap = issuanceCap_;
        yes = new OutcomeToken(marketId_, true, string.concat("Eros YES ", yesSymbol), yesSymbol);
        no = new OutcomeToken(marketId_, false, string.concat("Eros NO ", noSymbol), noSymbol);
    }

    // ------------------------------------------------------------------ binding (NM-C02)

    /// @notice Latch the engine the pinned registry selected for `marketId`, after checking that its
    ///         immutable listing describes this exact event, collateral and schedule.
    function bindMarket() external returns (address engine_) {
        if (engine != address(0)) revert AlreadyBound();
        RegistryMarketCore memory core = INativeRegistryReads(registry).getMarketCore(marketId);
        engine_ = core.engine;
        if (engine_ == address(0)) revert NotListed();
        if (core.tau != scheduledT) revert BindingMismatch(1);
        if (core.rulesHash != rulesHash) revert BindingMismatch(2);
        IMarketConfig.Listing memory l = IMarketConfig(engine_).listing();
        if (l.marketId != marketId) revert BindingMismatch(3);
        if (l.token != collateral) revert BindingMismatch(4);
        if (l.registry != registry) revert BindingMismatch(5);
        if (l.scheduledT != scheduledT) revert BindingMismatch(6);
        if (l.rulesHash != rulesHash) revert BindingMismatch(7);
        if (l.resolutionAuthority == address(0)) revert BindingMismatch(8);
        engine = engine_;
        emit Bound(engine_, l.resolutionAuthority, IMarketConfig(engine_).listingHash());
    }

    // ------------------------------------------------------------------ issuance (NM-C03, NM-C04)

    /// @notice True while new complete sets may be issued: bound, before T and before any recorded
    ///         engine halt (including an authenticated early halt), and not resolved.
    function issuanceOpen() public view returns (bool) {
        address e = engine;
        if (e == address(0) || resolved || block.timestamp >= scheduledT) return false;
        return !IResolutionEngine(e).getHaltSnapshot().halted;
    }

    /// @notice Pull exactly `atoms` collateral from the caller and mint `atoms` YES and NO to `receiver`.
    function split(uint256 atoms, address receiver) external nonReentrant {
        if (atoms == 0) revert ZeroAmount();
        if (receiver == address(0)) revert ZeroReceiver();
        if (!issuanceOpen()) revert IssuanceClosed();
        uint256 sets = outstandingSets + atoms;
        if (sets > issuanceCap) revert CapExceeded();
        uint256 before = INativeCollateral(collateral).balanceOf(address(this));
        collateral.safeTransferFrom(msg.sender, address(this), atoms);
        if (INativeCollateral(collateral).balanceOf(address(this)) - before != atoms) revert ShortTransfer();
        outstandingSets = sets;
        yes.mint(receiver, atoms);
        no.mint(receiver, atoms);
        emit Split(msg.sender, receiver, atoms);
    }

    /// @notice Burn `atoms` of the caller's own YES and NO and return `atoms` collateral to `receiver`.
    ///         Allowed after trading halt while the outcome is pending (sets stay fully backed).
    function merge(uint256 atoms, address receiver) external nonReentrant {
        if (atoms == 0) revert ZeroAmount();
        if (receiver == address(0)) revert ZeroReceiver();
        if (engine == address(0)) revert NotBound();
        if (resolved) revert Resolved();
        yes.burn(msg.sender, atoms);
        no.burn(msg.sender, atoms);
        outstandingSets -= atoms;
        collateral.safeTransfer(receiver, atoms);
        emit Merged(msg.sender, receiver, atoms);
    }

    // ------------------------------------------------------------------ resolution (NM-C05)

    /// @notice Copy the bound engine's accepted final payout value. YES -> 1e18, NO -> 0,
    ///         INVALID -> the engine's captured settlement price once ready. Idempotent once latched;
    ///         takes no price argument and has no admin override.
    function syncResolution() external returns (uint256) {
        if (resolved) return payoutYesWad;
        address e = engine;
        if (e == address(0)) revert NotBound();
        SettlementView memory s = IResolutionEngine(e).getSettlementStatus();
        if (!s.oracleFinalityAccepted) revert FinalityNotAccepted();
        uint256 p;
        if (s.finalOutcome == MathTypes.FinalOutcome.YES) {
            p = WAD;
        } else if (s.finalOutcome == MathTypes.FinalOutcome.NO) {
            p = 0;
        } else if (s.finalOutcome == MathTypes.FinalOutcome.INVALID) {
            // The status struct reports 0 while the INVALID price is pending; that is not NO.
            if (!s.invalidPriceReady) revert InvalidPricePending();
            p = s.settlementPriceE18;
            if (p > WAD) revert BadSettlementPrice();
        } else {
            revert FinalityNotAccepted();
        }
        resolved = true;
        finalOutcome = s.finalOutcome;
        payoutYesWad = p;
        emit ResolutionSynced(s.finalOutcome, p, s.snapshotId, outstandingSets);
        return p;
    }

    // ------------------------------------------------------------------ redemption (NM-C06)

    /// @notice Collateral atoms `redeem(yesAtoms, noAtoms)` pays at the latched price (one floor).
    function redeemValue(uint256 yesAtoms, uint256 noAtoms) public view returns (uint256) {
        if (!resolved) revert NotResolved();
        uint256 p = payoutYesWad;
        return (yesAtoms * p + noAtoms * (WAD - p)) / WAD;
    }

    /// @notice Burn the caller's own YES/NO and pay `redeemValue` to `receiver`. Zero-value losing
    ///         tokens may be burned. A complete set redeems to exactly one atom per set.
    function redeem(uint256 yesAtoms, uint256 noAtoms, address receiver)
        external
        nonReentrant
        returns (uint256 paid)
    {
        if (yesAtoms == 0 && noAtoms == 0) revert ZeroAmount();
        if (receiver == address(0)) revert ZeroReceiver();
        paid = redeemValue(yesAtoms, noAtoms);
        if (yesAtoms != 0) yes.burn(msg.sender, yesAtoms);
        if (noAtoms != 0) no.burn(msg.sender, noAtoms);
        totalRedeemedAtoms += paid;
        if (paid != 0) collateral.safeTransfer(receiver, paid);
        emit Redeemed(msg.sender, receiver, yesAtoms, noAtoms, paid);
    }
}
