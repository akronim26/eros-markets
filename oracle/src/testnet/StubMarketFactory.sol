// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IMarketConfig} from "@eros/interfaces/IMarketConfig.sol";
import {IMarketFactory} from "../interfaces/IMarketFactory.sol";
import {ResolutionEngineStub} from "./ResolutionEngineStub.sol";

/// @title StubMarketFactory — TESTNET ONLY
/// @notice Deploys one `ResolutionEngineStub` per market for the registry (plan §6.10; task O19.1).
///         Replaced by the shared MarketFactory through `registry.setFactory` once it exists. Never
///         deploy it on Monad mainnet; the deploy script refuses chainId 143.
contract StubMarketFactory is IMarketFactory {
    error OnlyRegistry();
    error MarketExists();

    address public immutable registry;
    mapping(bytes32 marketId => address engine) public engineOf;

    event MarketDeployed(bytes32 indexed marketId, address engine);

    constructor(address registry_) {
        registry = registry_;
    }

    function deployMarket(IMarketConfig.Listing calldata listing, bytes calldata engineInit)
        external
        returns (address engine)
    {
        if (msg.sender != registry) revert OnlyRegistry();
        if (engineOf[listing.marketId] != address(0)) revert MarketExists();
        ResolutionEngineStub stub = new ResolutionEngineStub();
        stub.initialize(listing, engineInit);
        engine = address(stub);
        engineOf[listing.marketId] = engine;
        emit MarketDeployed(listing.marketId, engine);
    }
}
