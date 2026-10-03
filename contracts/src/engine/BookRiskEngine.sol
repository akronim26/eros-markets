pragma solidity ^0.8.30;

import {Book} from "../Book.sol";
import {IMarketConfig} from "../interfaces/IMarketConfig.sol";
import {MarginMath} from "../math/MarginMath.sol";
import {RiskStorage} from "../risk/RiskStorage.sol";
import {CollateralVault} from "../vaults/CollateralVault.sol";
import {RiskAccountingBridge} from "./RiskAccountingBridge.sol";

contract BookRiskEngine is RiskAccountingBridge, Book {
    error UnsafeInitialConfiguration();
    error InvalidDeploymentDependency();

    constructor(CollateralVault vault, address reserveTreasury, IMarketConfig.Listing memory configuration)
        RiskStorage(vault, reserveTreasury, configuration.scheduledT, false, false)
        RiskAccountingBridge(1e18)
    {
        if (
            configuration.deploymentCapX != 1 || configuration.fundingEnabled
                || configuration.maxTraders != 1024 || configuration.maxLiqLotsPerBlock != 0
        ) {
            revert UnsafeInitialConfiguration();
        }
        if (
            address(vault).code.length == 0 || configuration.token.code.length == 0
                || address(vault.token()) != configuration.token || reserveTreasury == address(0)
                || configuration.registry == address(0) || configuration.resolutionAuthority.code.length == 0
        ) revert InvalidDeploymentDependency();
        MarginMath.RiskParams memory parameters;
        parameters.template = configuration.template;
        parameters.deploymentCapX = 1;
        _initMarket(configuration, parameters);
        _initBook(64);
    }

    function _traderOf(address owner) internal override returns (uint32 traderId) {
        traderId = _idOf[owner];
        if (traderId != 0) return traderId;
        for (uint256 participantIndex; participantIndex < participants.length; ++participantIndex) {
            if (participants[participantIndex] == owner) {
                traderId = uint32(participantIndex + 1);
                _remember(traderId, owner);
                return traderId;
            }
        }
        revert UnknownTrader(0);
    }

    function _liqSubmitIoc(OrderRequest memory request) internal override returns (uint64, uint256) {
        return _placeForced(request);
    }
}
