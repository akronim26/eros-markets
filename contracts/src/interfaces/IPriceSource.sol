// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

/// @title IPriceSource
/// @notice CP-PRICE boundary (spec §4.1, §9 CP-PRICE): the signed observation envelope an
///         independent index collector delivers to the engine. The collector team fetches venues
///         and signs; the engine only authenticates, orders and aggregates.
/// @dev Units: times are Unix seconds; prices wad (1e18 = 1 USDC per claim); depths in lots.
///      The signature covers the fields below plus `block.chainid` and the engine address.
interface IPriceSource {
    struct Observation {
        bytes32 marketId;
        bytes32 sourceId;
        uint64 sequence; // strictly increasing per source
        uint64 observedAt; // freshness clock
        uint64 publishedAt; // collector publish time; observedAt <= publishedAt
        uint256 priceWad; // impact-mid at depth N as computed by the source
        uint256 impactBidWad;
        uint256 impactAskWad;
        uint256 bidDepthLots;
        uint256 askDepthLots;
        bytes32 sourceRulesHash;
    }

    event ObservationAccepted(
        bytes32 indexed sourceId,
        uint64 sequence,
        uint64 observedAt,
        uint64 publishedAt,
        uint64 acceptedAt,
        uint256 priceWad,
        bool depthValid,
        bytes32 payloadDigest
    );

    /// @notice Deliver one signed observation. Reverts on any authentication or ordering failure.
    function submitObservation(Observation calldata obs, bytes calldata signature) external;

    /// @notice The digest the pinned signer must sign (domain-bound to chain and engine).
    function observationDigest(Observation calldata obs) external view returns (bytes32);
}
