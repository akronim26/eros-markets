// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {ObservationStore} from "risk/pricing/ObservationStore.sol";

/// Owned local fixture with a minimal listing view for the joined pipeline.
/// Real ingress/storage only; no trading, oracle or production factory composition.
contract PipelineDemoMarket is ObservationStore {
    struct InvalidRule {
        bool fallbackListed;
        uint64 captureGraceSecs;
        uint64 voidSecs;
        uint256 fallbackPriceWad;
    }
    struct DemoListing {
        bytes32 marketId;
        bytes32 indexSourceId;
        address indexSigner;
        bytes32 indexRulesHash;
        uint256 depthNLots;
        uint256 maxSpreadWad;
        uint64 listedAt;
        uint64 scheduledT;
        InvalidRule invalidRule;
    }
    DemoListing private _listing;

    constructor(bytes32 market, bytes32 source, address signer, bytes32 rules,
        uint256 depthLots, uint256 spread, uint64 listedAt, uint64 scheduledT) {
        require(block.chainid == 31337, "local pipeline only");
        require(depthLots > 0 && spread <= 1e18 && scheduledT >= listedAt + 86400, "bad local listing");
        _initIngress(market, source, DepthRule(depthLots, spread));
        _configureSource(source, signer, rules);
        _initStore(scheduledT);
        _listing = DemoListing(market, source, signer, rules, depthLots, spread, listedAt, scheduledT,
            InvalidRule(true, 3600, 30 days, 5e17));
    }

    function listing() external view returns (DemoListing memory) { return _listing; }
}
