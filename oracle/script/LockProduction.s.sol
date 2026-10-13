// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {stdJson} from "forge-std/StdJson.sol";
import {GovernanceOp} from "./GovernanceOp.sol";
import {ResolutionOracle} from "../src/ResolutionOracle.sol";

/// @title LockProduction
/// @notice `lockProduction()` as a Timelock operation for the Safe (plan §12.6, D13, ORC-13; task O19.4): ends
///         sim mode for good once a production trust set is active. With `TRUST_SET_ID` set, the operation first
///         activates that set (the production set created by `CreateTrustSet` with `PRODUCTION=true`). The calls
///         are simulated as the Timelock, so an operation without an active production set fails here with the
///         oracle's `ProductionSetRequired` instead of after the delay. Nothing is broadcast.
contract LockProduction is GovernanceOp {
    using stdJson for string;

    function run() external returns (bytes32 id) {
        string memory deployments = _deployments();
        address timelock = deployments.readAddress(".roles.timelock");
        ResolutionOracle ro = ResolutionOracle(_contract(deployments, "ResolutionOracle"));
        uint32 setId = uint32(vm.envOr("TRUST_SET_ID", uint256(0)));
        Call[] memory calls = new Call[](setId == 0 ? 1 : 2);
        uint256 n;
        if (setId != 0) n = _push(calls, n, address(ro), abi.encodeCall(ro.activateTrustSet, (setId)));
        _push(calls, n, address(ro), abi.encodeCall(ro.lockProduction, ()));
        id = _propose("lock production", calls, timelock);
    }
}
