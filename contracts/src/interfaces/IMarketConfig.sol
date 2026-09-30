// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {MarginMath} from "../math/MarginMath.sol";

/// @title IMarketConfig
/// @notice CP-FACTORY boundary (spec §5.3–5.4, §8.3–8.4; B019): the immutable listing an engine
///         is initialized with, plus the versioned mutable calibration identity.
/// @dev Units: times Unix seconds; prices wad; sizes lots. Immutable fields can never be rewritten
///      by a price or oracle callback. Mutable calibration is a versioned risk input identified by
///      a profile hash and only takes effect at a completed epoch.
interface IMarketConfig {
    struct InvalidRule {
        bool fallbackListed; // new-listing disclosed missing-data fallback (DEC-08)
        uint64 captureGraceSecs; // 3,600 for new listings
        uint256 fallbackPriceWad; // 0.5e18 for new listings
        uint64 voidSecs; // oracle void schedule used by the listing horizon gate (30 days)
    }

    struct Listing {
        bytes32 marketId;
        address token;
        address registry;
        address resolutionAuthority; // the pinned ResolutionOracle
        address monitor; // may request reduce-only; cannot halt or finalize
        address governance; // stages calibration profiles
        uint64 scheduledT;
        uint64 listedAt;
        bytes32 sourceHash;
        bytes32 rulesHash;
        InvalidRule invalidRule;
        MarginMath.Template template;
        uint256 deploymentCapX; // initial deployment 1
        uint32 maxTraders; // <= 1,024 in v1
        bytes32 indexSourceId;
        address indexSigner;
        bytes32 indexRulesHash;
        uint256 depthNLots;
        uint256 maxSpreadWad;
        uint256 bootstrapBandWad;
        uint64 minOrderLots;
        uint64 maxOrderLots; // <= uint48 max at the book boundary
        uint64 maxLiqLotsPerBlock; // 0 = not measured: forced-book liquidation disabled
        bool fundingEnabled; // false in the initial deployment manifest
    }

    struct ProfileVersion {
        uint64 version;
        bytes32 profileHash; // keccak256(abi.encode(MarginMath.RiskParams))
        uint64 effectiveAt;
    }

    function listing() external view returns (Listing memory);

    function listingHash() external view returns (bytes32);

    function activeProfile() external view returns (ProfileVersion memory);
}
