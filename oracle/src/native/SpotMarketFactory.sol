// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IMarketConfig} from "@eros/interfaces/IMarketConfig.sol";
import {IMarketFactory} from "../interfaces/IMarketFactory.sol";
import {SpotResolutionAnchor} from "./SpotResolutionAnchor.sol";

/// @title SpotMarketFactory
/// @notice Deploys one `SpotResolutionAnchor` per native spot market for the registry (NM-S01). The
///         registry has a single governance-set factory, so governance points it here for a spot listing
///         and back to the perp `MarketFactory` afterwards (`script/native/SpotMarketGovernance.s.sol`).
contract SpotMarketFactory is IMarketFactory {
    error OnlyRegistry();
    error MarketExists();
    error ZeroAddress();

    address public immutable registry;
    mapping(bytes32 marketId => address anchor) public anchorOf;

    event SpotMarketDeployed(bytes32 indexed marketId, address anchor);

    constructor(address registry_) {
        if (registry_ == address(0)) revert ZeroAddress();
        registry = registry_;
    }

    function deployMarket(IMarketConfig.Listing calldata listing, bytes calldata engineInit)
        external
        returns (address engine)
    {
        if (msg.sender != registry) revert OnlyRegistry();
        if (anchorOf[listing.marketId] != address(0)) revert MarketExists();
        SpotResolutionAnchor anchor = new SpotResolutionAnchor();
        engine = address(anchor);
        anchorOf[listing.marketId] = engine;
        anchor.initialize(listing, engineInit);
        emit SpotMarketDeployed(listing.marketId, engine);
    }
}
