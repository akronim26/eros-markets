// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {ObservationStore} from "risk/pricing/ObservationStore.sol";

/// Local-demo composition of the existing real ingress/store, not a listed engine.
/// No book, oracle, positions, margin, funding or settlement is implemented here.
contract LiveDemoMarket is ObservationStore {
    constructor(bytes32 market, bytes32 source, address signer, bytes32 rules,
        uint256 depthLots, uint256 spread, uint64 scheduledT) {
        require(block.chainid == 31337, "local demo only");
        require(depthLots > 0 && spread <= 1e18, "bad demo depth");
        _initIngress(market, source, DepthRule(depthLots, spread));
        _configureSource(source, signer, rules);
        _initStore(scheduledT);
    }
}
