// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {RiskView} from "@eros/risk/RiskView.sol";

/// @notice DEP-4: subset of B's RiskView the oracle reads (monitorRestricted).
interface IEngineMonitorView {
    function marketRiskView() external view returns (RiskView.MarketRiskView memory);
}
