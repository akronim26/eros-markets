// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {ECDSA} from "solady/utils/ECDSA.sol";
import {IPriceSource} from "../interfaces/IPriceSource.sol";
import {PricingMath} from "../math/PricingMath.sol";

/// @title PriceIngress
/// @notice Authenticated observation ingress (spec §4.1; B016). Verifies source identity, pinned
///         signer, chain/engine domain, strictly increasing sequence, nondecreasing observedAt and
///         timestamp order observedAt <= publishedAt <= acceptedAt (future tolerance zero).
/// @dev No venue fetching. A delayed observation is accepted into history with its own
///      observedAt; it never becomes fresh because of a late acceptance. Accepted samples are
///      handed to `_onIndexObservation` (ObservationStore). A source callback cannot change risk
///      parameters: this module only appends samples.
abstract contract PriceIngress is IPriceSource {
    error WrongMarket();
    error UnknownSource();
    error SourceAlreadyConfigured();
    error BadSignature();
    error DuplicateOrOldSequence();
    error BackwardsObservation();
    error FutureTimestamp();
    error BadTimestampOrder();
    error BadPrice();

    bytes32 internal constant OBSERVATION_TYPEHASH = keccak256(
        "Observation(bytes32 marketId,bytes32 sourceId,uint64 sequence,uint64 observedAt,uint64 publishedAt,uint256 priceWad,uint256 impactBidWad,uint256 impactAskWad,uint256 bidDepthLots,uint256 askDepthLots,bytes32 sourceRulesHash,uint256 chainId,address engine)"
    );

    struct SourceState {
        address signer;
        bytes32 rulesHash;
        uint64 lastSequence;
        uint64 lastObservedAt;
        bool configured;
    }

    /// @dev Depth validity parameters fixed at listing (N and the stressed spread bound).
    struct DepthRule {
        uint256 depthNLots;
        uint256 maxSpreadWad;
    }

    bytes32 internal _ingressMarketId;
    bytes32 internal _indexSourceId;
    DepthRule internal _depthRule;
    mapping(bytes32 sourceId => SourceState) internal _sources;

    function _initIngress(bytes32 marketId, bytes32 indexSourceId, DepthRule memory rule) internal {
        _ingressMarketId = marketId;
        _indexSourceId = indexSourceId;
        _depthRule = rule;
    }

    /// @dev Pinning happens once per source during initialization; there is no rotation path here.
    function _configureSource(bytes32 sourceId, address signer, bytes32 rulesHash) internal {
        if (_sources[sourceId].configured) revert SourceAlreadyConfigured();
        if (signer == address(0)) revert BadSignature();
        _sources[sourceId] = SourceState(signer, rulesHash, 0, 0, true);
    }

    function observationDigest(Observation calldata o) public view returns (bytes32) {
        return _digest(o);
    }

    function _digest(Observation calldata o) internal view returns (bytes32) {
        return keccak256(
            abi.encode(
                OBSERVATION_TYPEHASH,
                o.marketId,
                o.sourceId,
                o.sequence,
                o.observedAt,
                o.publishedAt,
                o.priceWad,
                o.impactBidWad,
                o.impactAskWad,
                o.bidDepthLots,
                o.askDepthLots,
                o.sourceRulesHash,
                block.chainid,
                address(this)
            )
        );
    }

    function submitObservation(Observation calldata o, bytes calldata signature) external virtual {
        _ingest(o, signature);
    }

    function _ingest(Observation calldata o, bytes calldata signature) internal returns (bytes32 digest) {
        if (o.marketId != _ingressMarketId) revert WrongMarket();
        SourceState storage src = _sources[o.sourceId];
        if (!src.configured) revert UnknownSource();
        if (o.sourceRulesHash != src.rulesHash) revert UnknownSource();
        digest = _digest(o);
        if (ECDSA.tryRecoverCalldata(digest, signature) != src.signer) revert BadSignature();
        if (o.sequence <= src.lastSequence) revert DuplicateOrOldSequence();
        if (o.observedAt < src.lastObservedAt) revert BackwardsObservation();
        if (o.observedAt > o.publishedAt) revert BadTimestampOrder();
        if (o.publishedAt > block.timestamp) revert FutureTimestamp(); // tolerance 0 s
        if (o.priceWad > 1e18 || o.impactBidWad > 1e18 || o.impactAskWad > 1e18) revert BadPrice();

        src.lastSequence = o.sequence;
        src.lastObservedAt = o.observedAt;

        (bool depthOk, uint256 mid) = PricingMath.impactMid(
            o.impactBidWad,
            o.impactAskWad,
            o.bidDepthLots,
            o.askDepthLots,
            _depthRule.depthNLots,
            _depthRule.maxSpreadWad
        );
        // The signed price must be the impact mid of the signed depth summary (floor((b + a) / 2)).
        if (depthOk && o.priceWad != mid) revert BadPrice();
        emit ObservationAccepted(
            o.sourceId, o.sequence, o.observedAt, o.publishedAt, uint64(block.timestamp), mid, depthOk, digest
        );
        if (o.sourceId == _indexSourceId) _onIndexObservation(o.observedAt, mid, depthOk);
    }

    /// @notice Last accepted sequence and observedAt for a source (monitoring view).
    function sourceState(bytes32 sourceId) external view returns (SourceState memory) {
        return _sources[sourceId];
    }

    /// @dev Store hook (ObservationStore). `valid` false contributes no coverage.
    function _onIndexObservation(uint64 observedAt, uint256 midWad, bool valid) internal virtual;
}
