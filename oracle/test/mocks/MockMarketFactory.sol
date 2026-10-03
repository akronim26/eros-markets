// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IMarketConfig} from "@eros/interfaces/IMarketConfig.sol";
import {IMarketFactory} from "../../src/interfaces/IMarketFactory.sol";
import {MockResolutionEngine} from "./MockResolutionEngine.sol";

/// @title MockMarketFactory
/// @notice Deploys a `MockResolutionEngine` per market, or a misbehaving one (task O11.1): an engine that
///         reports a wrong listing hash, an engine that is already halted, or a factory that reverts.
contract MockMarketFactory is IMarketFactory {
    enum Mode {
        NORMAL,
        WRONG_HASH,
        PRE_HALTED,
        REVERT
    }

    error MockFactoryReverted();
    error MarketExists();

    Mode public mode;
    address public lastEngine;
    bytes public lastEngineInit;
    IMarketConfig.Listing internal _lastListing;
    mapping(bytes32 marketId => address) public engineOf;

    function setMode(Mode m) external {
        mode = m;
    }

    function deployMarket(IMarketConfig.Listing calldata listing, bytes calldata engineInit)
        external
        returns (address engine)
    {
        if (mode == Mode.REVERT) revert MockFactoryReverted();
        if (engineOf[listing.marketId] != address(0)) revert MarketExists();
        MockResolutionEngine e = new MockResolutionEngine();
        e.initialize(listing, engineInit);
        if (mode == Mode.WRONG_HASH) e.setListingHashOverride(keccak256("wrong listing hash"));
        if (mode == Mode.PRE_HALTED) e.forceHalted();
        engine = address(e);
        engineOf[listing.marketId] = engine;
        (lastEngine, lastEngineInit, _lastListing) = (engine, engineInit, listing);
    }

    function lastListing() external view returns (IMarketConfig.Listing memory) {
        return _lastListing;
    }
}
