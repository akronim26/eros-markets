pragma solidity ^0.8.30;

import {IMarketConfig} from "../interfaces/IMarketConfig.sol";
import {IBookRiskHooks} from "../interfaces/IBookRiskHooks.sol";
import {MarginMath} from "../math/MarginMath.sol";
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
            configuration.deploymentCapX != 1 || configuration.fundingEnabled
                || configuration.maxTraders != 1024 || configuration.maxLiqLotsPerBlock != 0
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

    function _bookDepth(RiskContext memory context)
        internal
        view
        virtual
        returns (BookDepthQuote memory quote)
    {
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
