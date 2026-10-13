// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {ObservationStore} from "risk/pricing/ObservationStore.sol";

/// Test-only composition; existing ingress/store code is imported read-only.
contract FeedHarness is ObservationStore {
    bool private initialized;

    function initialize(bytes32 market, bytes32 source, address signer, bytes32 rules) external {
        require(!initialized, "initialized");
        initialized = true;
        _initIngress(market, source, DepthRule(500, 5e16));
        _configureSource(source, signer, rules);
        _initStore(100_000);
    }
}
