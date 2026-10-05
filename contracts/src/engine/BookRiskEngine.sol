pragma solidity ^0.8.30;

import {IMarketConfig} from "../interfaces/IMarketConfig.sol";
import {IBookRiskHooks} from "../interfaces/IBookRiskHooks.sol";
import {MarginMath} from "../math/MarginMath.sol";
import {HorizonMath} from "../math/HorizonMath.sol";
import {OrderAdmissionMath} from "../math/OrderAdmissionMath.sol";
import {PricingMath} from "../math/PricingMath.sol";
import {AccountingState, Stage} from "../math/RiskTypes.sol";
import {BookDepthSampler} from "../pricing/BookDepthSampler.sol";
import {RiskContext} from "../pricing/RiskPricing.sol";
import {RiskLifecycle} from "../risk/RiskLifecycle.sol";
import {RiskStorage} from "../risk/RiskStorage.sol";
import {CollateralVault} from "../vaults/CollateralVault.sol";
import {RiskAccountingBridge} from "./RiskAccountingBridge.sol";

contract BookRiskEngine is RiskAccountingBridge, BookDepthSampler {
    error UnsafeInitialConfiguration();
    error InvalidDeploymentDependency();
    error SameBlockBookSample();
    error InvalidCalibratedProfile();
    error ReserveSeedRequired();

    struct PendingBookSample {
        BookDepthQuote quote;
        uint64 observedAt;
        uint64 bookRevision;
        uint64 marketEpoch;
        uint64 riskVersion;
        uint256 observedBlock;
        bytes32 indexCheckpoint;
    }

    PendingBookSample private _pendingBookSample;
    uint256 private _lastSamplingBlock;
    uint64 private _lastCaptureTime;
    uint64 private _bookRevision;

    event BookDepthCaptured(uint64 observedAt, uint256 observedBlock, uint16 examined, bytes32 fingerprint);

    constructor(CollateralVault vault, address reserveTreasury, IMarketConfig.Listing memory configuration)
        RiskStorage(vault, reserveTreasury, configuration.scheduledT, false, false)
        RiskAccountingBridge(1e18)
    {
        if (
            configuration.deploymentCapX == 0 || configuration.deploymentCapX > 5 || configuration.fundingEnabled
                || configuration.maxTraders != 1024
                || (configuration.deploymentCapX == 1 && configuration.maxLiqLotsPerBlock != 0)
                || (configuration.deploymentCapX > 1 && configuration.maxLiqLotsPerBlock == 0)
                || configuration.maxLiqLotsPerBlock > (1 << 40)
        ) {
            revert UnsafeInitialConfiguration();
        }
        if (
            address(vault).code.length == 0 || configuration.token.code.length == 0
                || address(vault.token()) != configuration.token || reserveTreasury == address(0)
                || configuration.registry == address(0) || configuration.resolutionAuthority.code.length == 0
        ) revert InvalidDeploymentDependency();
        MarginMath.RiskParams memory parameters;
        parameters.template = configuration.template;
        parameters.deploymentCapX = 1;
        _initMarket(configuration, parameters);
        _initBook(8);
    }

    /// @notice A higher listing ceiling is only permission to stage calibration later.
    /// The initial profile remains uncalibrated 1x and all admissions check actual reserve cover.
    function activateMarket() public override {
        if (_listing.deploymentCapX > 1 && reserve.cashQ <= 0) revert ReserveSeedRequired();
        super.activateMarket();
    }

    /// @dev Structural/numeric validation, not evidence of empirical calibration. Future or
    /// expired envelopes remain full backing until both are live at the action's timestamp.
    function _validateRiskProfile(IMarketConfig.Listing memory listing_, MarginMath.RiskParams memory p)
        internal
        pure
        override
    {
        super._validateRiskProfile(listing_, p);
        if (!p.calibrated) return;
        if (
            p.h0Secs > type(uint64).max || p.queueSecs > type(uint64).max
                || p.absorptionClaimsPerMin == 0 || p.absorptionClaimsPerMin > type(uint128).max
                || p.epsilonWad == 0 || p.epsilonWad >= 1e18 || p.gammaWad < 1e18
                || p.gammaWad > type(uint128).max || p.sWad > 1e18 || p.lambdaWadPerClaim > 1e18
        ) revert InvalidCalibratedProfile();
        _validateEnvelope(p.realized);
        _validateEnvelope(p.templateEnv);
    }

    function _validateEnvelope(HorizonMath.Envelope memory e) private pure {
        if (
            e.hSecs.length > 32 || !HorizonMath.isValidEnvelope(e) || e.hSecs[0] == 0
                || e.validUntil <= e.validFrom || e.sigmaWad[e.sigmaWad.length - 1] > 1e18
        ) revert InvalidCalibratedProfile();
    }

    /// @notice Directional ceilings under the active calibration and current price/time gates.
    /// Position size, IM/MM, orders and reserve coverage can require more collateral.
    function leverageCaps() external view returns (uint256 longCapX, uint256 shortCapX) {
        RiskContext memory context = _pricingContext();
        if (!active || !context.markOk || context.fullBackingByTime || context.halted) return (1, 1);
        MarginMath.RiskParams memory p = _effectiveParams(context.economicTime);
        return (
            MarginMath.directionalCap(p.template, true, p.calibrated, p.deploymentCapX),
            MarginMath.directionalCap(p.template, false, p.calibrated, p.deploymentCapX)
        );
    }

    function _traderOf(address owner) internal override returns (uint32 traderId) {
        traderId = _idOf[owner];
        if (traderId != 0) return traderId;
        traderId = participantId[owner];
        if (traderId == 0) revert UnknownTrader(0);
        _remember(traderId, owner);
    }

    function _riskBeginAction()
        internal
        override(RiskLifecycle, IBookRiskHooks)
        returns (RiskSnapshot memory snapshot)
    {
        snapshot = super._riskBeginAction();
        ++_bookRevision;
    }

    function bookDepth() external view returns (BookDepthQuote memory) {
        return _bookDepth(_pricingContext());
    }

    function _bookDepth(RiskContext memory context) internal view virtual returns (BookDepthQuote memory quote) {
        if (
            !active || context.halted || !context.indexOk || context.stage == Stage.REDUCE_ONLY
                || (context.fundingFrozen && !_floorOrdersInvalidated)
                || _acctAccountingState() != AccountingState.READY
        ) return quote;
        return _scanBookDepth(_depthRule.depthNLots, context);
    }

    function _depthOrderEligibility(Order storage order, RiskContext memory context)
        internal
        view
        override
        returns (bool eligible, bytes32 accountFingerprint)
    {
        AccountView memory projected = _acctPreviewAccount(order.owner, context.economicTime);
        if (
            !projected.registered || order.marketEpoch != marketOrderEpoch
                || order.accountEpoch != projected.orderEpoch
                || (!context.markOk && !_inBand(context, order.tick))
        ) return (false, bytes32(0));
        OrderAdmissionMath.OrderSums memory reservations = _resSums(order.owner);
        OrderAdmissionMath.CoverageInput memory coverage =
            _acctPreviewCoverage(order.owner, reservations, 0, 0, context.economicTime);
        eligible = coverage.d0Q == 0 && coverage.d1Q == 0 && coverage.marketOk;
        accountFingerprint = keccak256(abi.encode(projected, reservations, eligible));
    }

    function _indexCheckpointAt(uint64 observedAt) internal view returns (bytes32) {
        (bool found, PricingMath.Cum memory checkpoint) = _floorCp(INDEX, observedAt);
        return found ? keccak256(abi.encode(checkpoint)) : bytes32(0);
    }

    function samplePerp() external nonReentrant returns (bool published) {
        if (_lastSamplingBlock == block.number) revert SameBlockBookSample();
        _lastSamplingBlock = block.number;
        RiskContext memory context = _pricingContext();
        PendingBookSample memory pending = _pendingBookSample;
        if (context.halted) {
            delete _pendingBookSample;
            return false;
        }
        BookDepthQuote memory quote = _bookDepth(context);
        if (pending.observedBlock != 0) {
            bool unchanged = pending.observedBlock < block.number
                && context.economicTime - pending.observedAt <= STALE && pending.bookRevision == _bookRevision
                && pending.marketEpoch == marketOrderEpoch && pending.riskVersion == context.riskVersion
                && pending.indexCheckpoint == _indexCheckpointAt(pending.observedAt)
                && pending.quote.fingerprint == quote.fingerprint;
            if (unchanged) {
                (published,) = PricingMath.impactMid(
                    pending.quote.bidWad,
                    pending.quote.askWad,
                    pending.quote.bidDepthLots,
                    pending.quote.askDepthLots,
                    _depthRule.depthNLots,
                    _depthRule.maxSpreadWad
                );
                if (published && _sources[_indexSourceId].lastObservedAt <= pending.observedAt) {
                    return false;
                }
            }
            _recordPerp(
                pending.observedAt,
                published ? pending.quote.bidWad : 0,
                published ? pending.quote.askWad : 0,
                published ? pending.quote.bidDepthLots : 0,
                published ? pending.quote.askDepthLots : 0
            );
        }
        delete _pendingBookSample;
        if (context.economicTime > _lastCaptureTime) {
            _lastCaptureTime = context.economicTime;
            _pendingBookSample = PendingBookSample(
                quote,
                context.economicTime,
                _bookRevision,
                marketOrderEpoch,
                context.riskVersion,
                block.number,
                _indexCheckpointAt(context.economicTime)
            );
            emit BookDepthCaptured(context.economicTime, block.number, quote.examined, quote.fingerprint);
        }
    }

    function _liqSubmitIoc(OrderRequest memory request) internal override returns (uint64, uint256) {
        return _placeForced(request);
    }
}
