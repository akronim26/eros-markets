// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {FinalizeStatus} from "../types/OracleTypes.sol";

/// @notice Stateless batching helper. Each inner call is wrapped in try/catch so one market cannot block others.
interface IKeeperRouter {
    function finalizeMany(bytes32[] calldata ids)
        external
        returns (FinalizeStatus[] memory statuses, bool[] memory reverted);
    function assertMany(bytes32[] calldata ids) external returns (bool[] memory asserted);
    function haltAndRequest(bytes32 id) external returns (bool halted, bool requested);
}
