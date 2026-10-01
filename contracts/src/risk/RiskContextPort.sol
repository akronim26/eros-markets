// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {RejectCode} from "../math/RiskTypes.sol";
import {IMarketConfig} from "../interfaces/IMarketConfig.sol";
import {MarginMath} from "../math/MarginMath.sol";
import {LifecycleMath} from "../math/LifecycleMath.sol";
import {OrderAdmissionMath as OA} from "../math/OrderAdmissionMath.sol";
import {PriceIngress} from "../pricing/PriceIngress.sol";
import {RiskPricing, RiskContext} from "../pricing/RiskPricing.sol";

/// @title RiskContextPort
/// @notice Config, authority and boundary port (B019). Holds the immutable listing (validated
///         once), the versioned calibration, role checks, and the internal functions Person A
///         consumes: the frozen per-action RiskContext, cutoffs and the guarded-release decision.
/// @dev Nothing here writes cash, positions or reserve state. Oracle and price callbacks have no
///      path to the listing or the calibration.
abstract contract RiskContextPort is RiskPricing, IMarketConfig {
    error AlreadyInitialized();
    error BadListing(uint8 reason);
    error RiskUnauthorized();
    error ProfileHashMismatch();

    uint8 internal constant L_HORIZON_MIN = 1;
    uint8 internal constant L_HORIZON_VOID = 2;
    uint8 internal constant L_FALLBACK = 3;
    uint8 internal constant L_ADDRESS = 4;
    uint8 internal constant L_BOUNDS = 5;

    uint256 internal constant NEW_LISTING_FALLBACK_WAD = 5e17;
    uint64 internal constant NEW_LISTING_GRACE = 3600;
    uint64 internal constant MAX_TRADERS_V1 = 1024;

    Listing internal _listing;
    bytes32 internal _listingHash;
    bool internal _initialized;
    MarginMath.RiskParams internal _params;
    MarginMath.RiskParams internal _stagedParams;
    ProfileVersion internal _active;

    // ------------------------------------------------------------------ initialization

    function validateListing(Listing memory l) public pure returns (bool ok, uint8 reason) {
        if (l.resolutionAuthority == address(0) || l.monitor == address(0) || l.governance == address(0)) {
            return (false, L_ADDRESS);
        }
        if (l.indexSigner == address(0) || l.token == address(0)) return (false, L_ADDRESS);
        if (l.scheduledT < l.listedAt + LifecycleMath.MIN_LISTING_HORIZON) return (false, L_HORIZON_MIN);
        if (
            uint256(l.scheduledT) + l.invalidRule.captureGraceSecs
                > uint256(l.listedAt) + l.invalidRule.voidSecs
        ) {
            return (false, L_HORIZON_VOID);
        }
        if (l.invalidRule.fallbackListed) {
            if (l.invalidRule.fallbackPriceWad != NEW_LISTING_FALLBACK_WAD) return (false, L_FALLBACK);
            if (l.invalidRule.captureGraceSecs != NEW_LISTING_GRACE) return (false, L_FALLBACK);
        }
        if (l.maxTraders == 0 || l.maxTraders > MAX_TRADERS_V1) return (false, L_BOUNDS);
        if (l.maxOrderLots == 0 || l.maxOrderLots > type(uint48).max || l.minOrderLots == 0) {
            return (false, L_BOUNDS);
        }
        if (l.minOrderLots > l.maxOrderLots || l.deploymentCapX == 0 || l.depthNLots == 0) {
            return (false, L_BOUNDS);
        }
        return (true, 0);
    }

    function profileHashOf(MarginMath.RiskParams memory p) public pure returns (bytes32) {
        return keccak256(abi.encode(p));
    }

    /// @notice One-time initialization from the factory listing. There is no later setter.
    function _initMarket(Listing memory l, MarginMath.RiskParams memory p) internal {
        if (_initialized) revert AlreadyInitialized();
        (bool ok, uint8 reason) = validateListing(l);
        if (!ok) revert BadListing(reason);
        _initialized = true;
        _listing = l;
        _listingHash = keccak256(abi.encode(l));
        _initIngress(l.marketId, l.indexSourceId, PriceIngress.DepthRule(l.depthNLots, l.maxSpreadWad));
        _configureSource(l.indexSourceId, l.indexSigner, l.indexRulesHash);
        bytes32 h = profileHashOf(p);
        _params = p;
        _active = ProfileVersion(1, h, uint64(block.timestamp));
        _initRiskPricing(l.scheduledT, l.listedAt, l.bootstrapBandWad, h);
    }

    // ------------------------------------------------------------------ views (IMarketConfig)

    function listing() external view returns (Listing memory) {
        return _listing;
    }

    function listingHash() external view returns (bytes32) {
        return _listingHash;
    }

    function activeProfile() external view returns (ProfileVersion memory) {
        return _active;
    }

    // ------------------------------------------------------------------ roles

    function _onlyResolutionAuthority() internal view {
        if (msg.sender != _listing.resolutionAuthority) revert RiskUnauthorized();
    }

    function _onlyMonitor() internal view {
        if (msg.sender != _listing.monitor) revert RiskUnauthorized();
    }

    function _onlyGovernance() internal view {
        if (msg.sender != _listing.governance) revert RiskUnauthorized();
    }

    // ------------------------------------------------------------------ calibration

    /// @notice Governance stages a new calibration; it becomes active at the next completed epoch
    ///         (never mid-epoch, never retroactively).
    function stageRiskParams(MarginMath.RiskParams calldata p) external {
        _onlyGovernance();
        _stagedParams = p;
        _stageRiskProfile(profileHashOf(p));
    }

    /// @notice Hook for Person A's rollover commit (S-4): activate staged params, then pricing mode.
    function _riskEpochOpened() internal {
        if (_hasStagedProfile) {
            if (profileHashOf(_stagedParams) != _stagedProfileHash) revert ProfileHashMismatch();
            _params = _stagedParams;
        }
        _onEpochOpening();
        _active = ProfileVersion(_riskVersion, _profileHash, uint64(block.timestamp));
    }

    function _riskParams() internal view returns (MarginMath.RiskParams memory) {
        return _params;
    }

    // ------------------------------------------------------------------ port for Person A

    /// @notice Frozen per-action context: prices, stage, versions. No cash/OI/coverage inside.
    function _riskContextForAction() internal view returns (RiskContext memory) {
        return _pricingContext();
    }

    function _riskAccrualCutoff(uint64 activeEpochEnd, uint64 frozenRolloverCutoff)
        internal
        view
        returns (uint64)
    {
        uint256 haltAt = LifecycleMath.economicHaltAt(_scheduledT, _earlyHaltAt());
        return uint64(LifecycleMath.accrualCutoff(haltAt, activeEpochEnd, frozenRolloverCutoff));
    }

    function _riskFundingCutoff(uint64 activeEpochEnd, uint64 fundingStopAt, uint64 frozenRolloverCutoff)
        internal
        view
        returns (uint64)
    {
        uint256 early = _earlyHaltAt();
        return uint64(
            LifecycleMath.fundingCutoff(
                LifecycleMath.FundingCutoffInputs(
                    block.timestamp,
                    activeEpochEnd,
                    _scheduledT,
                    fundingStopAt,
                    _fundingFreshThrough(),
                    early,
                    frozenRolloverCutoff
                )
            )
        );
    }

    struct ReleaseInput {
        int256 cashAfterQ; // settled cash after the proposed release
        int256 lots;
        OA.OrderSums sums; // current-epoch reservations
        OA.CoverageInput coverageAfter; // A's order-aware deficits and market check after release
    }

    /// @notice Guarded release decision (A017 consumes). Halted -> no. Missing normal mark -> only
    ///         if the account stays exactly backed (bootstrap path, index valid). Otherwise the
    ///         all-prefix IM envelope must still pass at the current mark.
    function _riskReleaseDecision(ReleaseInput memory r) internal view returns (bool ok, RejectCode reason) {
        RiskContext memory c = _pricingContext();
        if (c.halted) return (false, RejectCode.HALTED);
        if (!r.coverageAfter.marketOk) return (false, RejectCode.MARKET_COVERAGE);
        bool exactlyBacked = r.coverageAfter.d0Q == 0 && r.coverageAfter.d1Q == 0;
        if (!c.markOk) {
            if (c.indexOk && exactlyBacked) return (true, RejectCode.NONE);
            return (false, RejectCode.INVALID_PRICE_OR_SIZE);
        }
        if (c.fullBackingByTime && !exactlyBacked) return (false, RejectCode.BAD_STAGE);
        MarginMath.RiskParams memory p = _params;
        return OA.admit(
            OA.Account(r.cashAfterQ, r.lots),
            r.sums,
            OA.Pricing(c.markWad, c.secsToT, c.economicTime),
            p,
            r.coverageAfter
        );
    }
}
