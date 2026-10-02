// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {IResolutionEngine} from "@eros/interfaces/IResolutionIngress.sol";

/// @notice Toolchain smoke test (task O00.2, plan §12.2a). Proves that auto-detect builds UMA's
///         0.8.16 sources next to our 0.8.30 sources, that the UMA artifacts can be deployed with
///         `deployCode`, and that engine interfaces resolve through the eros remapping.
contract ToolchainTest is Test {
    function test_umaArtifactDeploysFromThe0816Build() public {
        address finder = deployCode("Finder.sol:Finder");
        assertTrue(finder != address(0), "Finder not deployed");
        assertGt(finder.code.length, 0, "Finder has no code");
    }

    function test_engineInterfaceResolvesThroughRemapping() public pure {
        assertEq(IResolutionEngine.settle.selector, bytes4(keccak256("settle(uint8)")));
    }
}
