// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IMarketConfig} from "@eros/interfaces/IMarketConfig.sol";
import {IResolutionEngine, HaltView, SettlementView} from "@eros/interfaces/IResolutionIngress.sol";
import {MathTypes} from "@eros/math/MathTypes.sol";
import {ClearingPhase} from "@eros/math/RiskTypes.sol";
import {RiskView} from "@eros/risk/RiskView.sol";
import {IEngineMonitorView} from "../interfaces/IEngineMonitorView.sol";

/// @title SpotResolutionAnchor
/// @notice The registry-listed "engine" of a native spot prediction market (NM-S01). A spot market has
///         no perp: trading happens on Kuru YES/NO books and custody is the bound `NativeOutcomeVault`.
///         The oracle still needs one contract per market to halt at T and to accept the final outcome;
///         this is that contract and nothing else. It holds no tokens, positions or accounting.
///
///         Oracle-facing behaviour matches the engine's `ResolutionIngress` (and `ResolutionEngineStub`):
///         pinned-authority `halt` / `settle` / `settleInvalid`, idempotent halt at T, Y ∈ {0, 1}, the same
///         outcome again → false, a conflicting outcome reverts.
///
///         Spot rules pinned here:
///           - open interest is always 0 (no perp), so oracle bonds use the market's minimum bond;
///           - INVALID pays the listing's fallback price, which must be exactly 0.5 (one YES and one NO
///             each redeem for half a collateral unit, so a complete set always redeems for one);
///           - no monitor restriction, so no early halt: the market halts at T and resolves after it.
/// @dev Error names follow the engine, so selectors match.
contract SpotResolutionAnchor is IResolutionEngine, IMarketConfig, IEngineMonitorView {
    error AlreadyInitialized();
    error RiskUnauthorized();
    error BadListing(uint8 reason);
    error BadOutcome();
    error ConflictingFinalOutcome();
    error ScheduledHaltNotYet();

    uint8 internal constant L_HORIZON_VOID = 2; // engine `RiskContextPort` reason code
    uint8 internal constant L_INVALID_PRICE = 3;
    uint8 internal constant L_ENGINE_INIT = 4;
    uint256 public constant INVALID_PRICE_WAD = 5e17;

    address public immutable factory;

    Listing internal _listing;
    bytes32 internal _listingHash;
    bool internal _initialized;
    HaltView internal _halt;
    MathTypes.FinalOutcome internal _final;

    constructor() {
        factory = msg.sender;
    }

    /// @notice Once, by the factory. `engineInit` must be empty: a spot market has no engine parameters.
    function initialize(Listing calldata l, bytes calldata engineInit) external {
        if (msg.sender != factory) revert RiskUnauthorized();
        if (_initialized) revert AlreadyInitialized();
        if (engineInit.length != 0) revert BadListing(L_ENGINE_INIT);
        if (uint256(l.scheduledT) + l.invalidRule.captureGraceSecs > uint256(l.listedAt) + l.invalidRule.voidSecs) {
            revert BadListing(L_HORIZON_VOID);
        }
        if (!l.invalidRule.fallbackListed || l.invalidRule.fallbackPriceWad != INVALID_PRICE_WAD) {
            revert BadListing(L_INVALID_PRICE);
        }
        _initialized = true;
        _listing = l;
        _listingHash = keccak256(abi.encode(l));
    }

    // ------------------------------------------------------------------ IResolutionEngine

    function halt() external returns (HaltView memory) {
        _onlyAuthority();
        _materialize();
        return _halt;
    }

    function materializeScheduledHalt() external returns (HaltView memory) {
        if (block.timestamp < _listing.scheduledT) revert ScheduledHaltNotYet();
        _materialize();
        return _halt;
    }

    function settle(uint8 Y) external returns (bool newlyAccepted) {
        _onlyAuthority();
        if (Y > 1) revert BadOutcome();
        return _accept(Y == 1 ? MathTypes.FinalOutcome.YES : MathTypes.FinalOutcome.NO);
    }

    function settleInvalid() external returns (bool newlyAccepted) {
        _onlyAuthority();
        return _accept(MathTypes.FinalOutcome.INVALID);
    }

    function getHaltSnapshot() external view returns (HaltView memory) {
        return _halt;
    }

    /// @notice The outcome is claimable as soon as the oracle has accepted it: YES → 1, NO → 0,
    ///         INVALID → 0.5. There is no price capture to wait for.
    function getSettlementStatus() external view returns (SettlementView memory v) {
        bool finalSet = _final != MathTypes.FinalOutcome.UNSET;
        v.halted = _halt.halted;
        v.finalOutcome = _final;
        v.oracleFinalityAccepted = finalSet;
        v.invalidPriceReady = _final == MathTypes.FinalOutcome.INVALID;
        if (finalSet) {
            v.settlementPriceE18 = _final == MathTypes.FinalOutcome.YES
                ? 1e18
                : _final == MathTypes.FinalOutcome.NO ? 0 : INVALID_PRICE_WAD;
        }
        v.snapshotId = _halt.snapshotId;
        v.claimsEnabled = finalSet;
        v.accountingComplete = finalSet;
        v.phase = !_halt.halted ? ClearingPhase.LIVE : !finalSet ? ClearingPhase.HALTED : ClearingPhase.READY;
    }

    // ------------------------------------------------------------------ IMarketConfig

    function listing() external view returns (Listing memory) {
        return _listing;
    }

    function listingHash() external view returns (bytes32) {
        return _listingHash;
    }

    function activeProfile() external pure returns (ProfileVersion memory p) {
        return p;
    }

    // ------------------------------------------------------------------ IEngineMonitorView

    /// @notice Never monitor-restricted, so the oracle's early check (`requestEarlyCheck`) cannot start.
    function marketRiskView() external view returns (RiskView.MarketRiskView memory v) {
        v.asOfTime = uint64(block.timestamp);
    }

    // ------------------------------------------------------------------ internals

    function _onlyAuthority() internal view {
        if (msg.sender != _listing.resolutionAuthority) revert RiskUnauthorized();
    }

    function _accept(MathTypes.FinalOutcome o) internal returns (bool newlyAccepted) {
        _materialize();
        if (_final == o) return false;
        if (_final != MathTypes.FinalOutcome.UNSET) revert ConflictingFinalOutcome();
        _final = o;
        return true;
    }

    /// @dev Idempotent. Always a scheduled halt at T: the oracle halts only at/after T for this market
    ///      (no early check), and an authority call before T still records T as the economic halt.
    function _materialize() internal {
        if (_halt.halted) return;
        uint64 t = _listing.scheduledT;
        _halt.halted = true;
        _halt.economicHaltAt = t;
        _halt.haltRecordedAt = uint64(block.timestamp);
        _halt.snapshotId = keccak256(abi.encode(_listing.marketId, t));
    }
}
