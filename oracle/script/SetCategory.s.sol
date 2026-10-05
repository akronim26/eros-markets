// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {stdJson} from "forge-std/StdJson.sol";
import {GovernanceOp} from "./GovernanceOp.sol";
import {MarketRegistry} from "../src/MarketRegistry.sol";

/// @title SetCategory
/// @notice `registry.setCategory(categoryId, gateHash, u95Bps, sampleN, true)` as a Timelock operation for the Safe
///         (plan §10 step 6; task O39.6): validates a category for the auto path with the gate and the measured
///         bound from the validation report (`oracle/validation/report/*.json`, its `setCategory` entry), passed as
///         `CATEGORY_ID`, `GATE_HASH`, `U95_BPS` and `SAMPLE_N`. `VALIDATED=false` revokes it instead. The call is
///         simulated as the Timelock, so a bad value fails here; the registry stamps `validatedAt` at execution, and
///         only markets halted at or after it can auto-propose. Nothing is broadcast.
contract SetCategory is GovernanceOp {
    using stdJson for string;

    function run() external returns (bytes32 id) {
        string memory deployments = _deployments();
        address timelock = deployments.readAddress(".roles.timelock");
        MarketRegistry reg = MarketRegistry(_contract(deployments, "MarketRegistry"));
        bytes32 categoryId = vm.envBytes32("CATEGORY_ID");
        bytes32 gateHash = vm.envBytes32("GATE_HASH");
        uint16 u95 = uint16(vm.envUint("U95_BPS"));
        uint32 n = uint32(vm.envUint("SAMPLE_N"));
        bool validated = vm.envOr("VALIDATED", true);
        Call[] memory calls = new Call[](1);
        _push(calls, 0, address(reg), abi.encodeCall(reg.setCategory, (categoryId, gateHash, u95, n, validated)));
        id = _propose(validated ? "validate category" : "revoke category", calls, timelock);
    }
}
