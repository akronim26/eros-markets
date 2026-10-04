// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IMarketConfig} from "@eros/interfaces/IMarketConfig.sol";
import {
    IResolutionEngine,
    HaltView,
    SettlementView,
    FinalOutcome,
    ClearingPhase
} from "@eros/interfaces/IResolutionIngress.sol";
import {RiskView} from "@eros/risk/RiskView.sol";
import {IEngineMonitorView} from "../interfaces/IEngineMonitorView.sol";

/// @title ResolutionEngineStub — TESTNET ONLY
/// @notice Stand-in for the market engine until the real engine and factory exist (plan §6.10, DEP-1/2;
///         task O19.1). It copies the oracle-facing behaviour of B's `ResolutionIngress` so the oracle
///         cannot tell the difference: pinned-authority halt and settle, idempotent halt, early versus
///         scheduled `economicHaltAt`, Y ∈ {0, 1}, same outcome → false, conflicting outcome reverts.
///         It holds no positions, no cash and no accounting. Never deploy it on Monad mainnet; the
///         deploy script refuses chainId 143.
/// @dev Errors use the engine's names, so their selectors match the real engine.
contract ResolutionEngineStub is IResolutionEngine, IMarketConfig, IEngineMonitorView {
    error AlreadyInitialized();
    error Unauthorized();
    error BadListing(uint8 reason);
    error BadOutcome();
    error ConflictingFinalOutcome();
    error ScheduledHaltNotYet();

    uint8 internal constant L_HORIZON_VOID = 2; // engine `RiskContextPort` reason code

    address public immutable factory;

    Listing internal _listing;
    bytes32 internal _listingHash;
    bool internal _initialized;
    uint256 internal _oiLots;
    HaltView internal _halt;
    FinalOutcome internal _final;
    bool internal _monitorRestricted;

    constructor() {
        factory = msg.sender;
    }

    /// @notice Once, by the factory. `engineInit = abi.encode(uint256 oiLots)`: the OI reported at the halt.
    function initialize(Listing calldata l, bytes calldata engineInit) external {
        if (msg.sender != factory) revert Unauthorized();
        if (_initialized) revert AlreadyInitialized();
        if (uint256(l.scheduledT) + l.invalidRule.captureGraceSecs > uint256(l.listedAt) + l.invalidRule.voidSecs) {
            revert BadListing(L_HORIZON_VOID);
        }
        _initialized = true;
        _listing = l;
        _listingHash = keccak256(abi.encode(l));
        _oiLots = abi.decode(engineInit, (uint256));
    }

    // ------------------------------------------------------------------ IResolutionEngine

    function halt() external virtual returns (HaltView memory) {
        _onlyAuthority();
        _materialize(true);
        return _halt;
    }

    function materializeScheduledHalt() external virtual returns (HaltView memory) {
        if (block.timestamp < _listing.scheduledT) revert ScheduledHaltNotYet();
        _materialize(false);
        return _halt;
    }

    function settle(uint8 Y) external virtual returns (bool newlyAccepted) {
        _onlyAuthority();
        if (Y > 1) revert BadOutcome();
        return _accept(Y == 1 ? FinalOutcome.YES : FinalOutcome.NO);
    }

    function settleInvalid() external virtual returns (bool newlyAccepted) {
        _onlyAuthority();
        return _accept(FinalOutcome.INVALID);
    }

    function getHaltSnapshot() external view virtual returns (HaltView memory) {
        return _halt;
    }

    /// @notice Claims open once the outcome is final; for INVALID only from T, when the real engine's
    ///         price capture can run. The stub has no index, so it reports the listing's fallback price.
    function getSettlementStatus() external view returns (SettlementView memory v) {
        bool finalSet = _final != FinalOutcome.UNSET;
        bool binary = _final == FinalOutcome.YES || _final == FinalOutcome.NO;
        bool priceReady = binary || (_final == FinalOutcome.INVALID && block.timestamp >= _listing.scheduledT);
        v.halted = _halt.halted;
        v.finalOutcome = _final;
        v.oracleFinalityAccepted = finalSet;
        v.invalidPriceReady = _final == FinalOutcome.INVALID && priceReady;
        if (priceReady) {
            v.settlementPriceE18 = _final == FinalOutcome.YES
                ? 1e18
                : _final == FinalOutcome.NO ? 0 : _listing.invalidRule.fallbackPriceWad;
        }
        v.snapshotId = _halt.snapshotId;
        v.claimsEnabled = finalSet && priceReady;
        v.accountingComplete = v.claimsEnabled;
        v.phase = !_halt.halted
            ? ClearingPhase.LIVE
            : !finalSet ? ClearingPhase.HALTED : v.claimsEnabled ? ClearingPhase.READY : ClearingPhase.PREPARING;
    }

    // ------------------------------------------------------------------ IMarketConfig

    function listing() external view returns (Listing memory) {
        return _listing;
    }

    function listingHash() external view virtual returns (bytes32) {
        return _listingHash;
    }

    function activeProfile() external pure returns (ProfileVersion memory p) {
        return p;
    }

    // ------------------------------------------------------------------ IEngineMonitorView

    function marketRiskView() external view returns (RiskView.MarketRiskView memory v) {
        v.asOfTime = uint64(block.timestamp);
        v.monitorRestricted = _monitorRestricted;
    }

    /// @notice Stands in for the engine's `requestReduceOnly` / `clearReduceOnly` (monitor only).
    function setMonitorRestricted(bool restricted) external {
        if (msg.sender != _listing.monitor) revert Unauthorized();
        _monitorRestricted = restricted;
    }

    // ------------------------------------------------------------------ internals

    function _onlyAuthority() internal view {
        if (msg.sender != _listing.resolutionAuthority) revert Unauthorized();
    }

    function _accept(FinalOutcome o) internal returns (bool newlyAccepted) {
        _materialize(true);
        if (_final == o) return false;
        if (_final != FinalOutcome.UNSET) revert ConflictingFinalOutcome();
        _final = o;
        return true;
    }

    /// @dev Idempotent. `byOracle` before T is an early halt at block time; otherwise the halt is at T.
    function _materialize(bool byOracle) internal virtual {
        if (_halt.halted) return;
        uint64 nowTs = uint64(block.timestamp);
        uint64 t = _listing.scheduledT;
        uint64 at = byOracle && nowTs < t ? nowTs : t;
        _halt.halted = true;
        _halt.economicHaltAt = at;
        _halt.haltRecordedAt = nowTs;
        _halt.oiHaltLots = _oiLots;
        _halt.snapshotId = keccak256(abi.encode(_listing.marketId, at));
    }
}
