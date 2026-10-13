pragma solidity ^0.8.30;

import {BookRiskEngine} from "@eros/engine/BookRiskEngine.sol";
import {IMarketConfig} from "@eros/interfaces/IMarketConfig.sol";
import {CollateralVault} from "@eros/vaults/CollateralVault.sol";
import {RiskContext} from "@eros/pricing/RiskPricing.sol";
import {IMarketRegistry} from "../interfaces/IMarketRegistry.sol";
import {MarketCore} from "../types/OracleTypes.sol";

contract RegistryBookRiskEngine is BookRiskEngine {
    error InvalidMarketRegistration();
    error OpenInterestCapExceeded(uint256 actualLots, uint256 capLots);

    constructor(CollateralVault vault, address reserveTreasury, IMarketConfig.Listing memory configuration)
        BookRiskEngine(vault, reserveTreasury, configuration)
    {}

    function marketOiCapLots() public view returns (uint256) {
        MarketCore memory core = IMarketRegistry(_listing.registry).getMarketCore(_listing.marketId);
        if (core.engine != address(this)) revert InvalidMarketRegistration();
        return core.oiCapLots;
    }

    function _acctPostFill(FillDelta memory delta) internal override {
        uint256 capLots = marketOiCapLots();
        super._acctPostFill(delta);
        if (oiAllLots > capLots) revert OpenInterestCapExceeded(oiAllLots, capLots);
    }

    function _bookDepth(RiskContext memory context) internal view override returns (BookDepthQuote memory quote) {
        uint256 capLots = marketOiCapLots();
        if (oiAllLots > capLots || capLots - oiAllLots < _depthRule.depthNLots) return quote;
        return super._bookDepth(context);
    }
}
