// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IMarketConfig} from "@eros/interfaces/IMarketConfig.sol";

/// @notice DEP-2, proposed to CP-FACTORY (audit C-01). MarketRegistry is the only caller.
interface IMarketFactory {
    /// Deploys, initializes and registers one market's engine atomically. MUST bind
    /// listing.resolutionAuthority / registry / marketId immutably and revert on a reused marketId.
    function deployMarket(IMarketConfig.Listing calldata listing, bytes calldata engineInit)
        external
        returns (address engine);
}
