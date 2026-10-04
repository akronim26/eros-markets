// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {TestUSDC} from "../../src/testnet/TestUSDC.sol";

/// @notice Task O19.3: TestUSDC (S-13), the testnet bond token: 6 decimals, an open faucet capped per call,
///         no other knobs, and no deployment on Monad mainnet.
contract TestUSDCTest is Test {
    function test_token() public {
        TestUSDC t = new TestUSDC();
        assertEq(t.decimals(), 6);
        assertEq(t.symbol(), "tUSDC");
        assertEq(t.name(), "Eros Test USDC");
        address anyone = makeAddr("anyone");
        vm.prank(anyone);
        t.mint(anyone, 100_000e6); // exactly the cap
        assertEq(t.balanceOf(anyone), 100_000e6);
        vm.expectRevert(TestUSDC.AboveFaucetCap.selector);
        t.mint(anyone, 100_000e6 + 1);
        vm.prank(anyone);
        assertTrue(t.transfer(address(1), 1e6));
        assertEq(t.totalSupply(), 100_000e6);
    }

    function test_refusesMainnet() public {
        vm.chainId(143);
        vm.expectRevert(TestUSDC.MainnetRefused.selector);
        new TestUSDC();
    }
}
