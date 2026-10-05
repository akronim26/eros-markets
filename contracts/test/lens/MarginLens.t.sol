// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;
import {Test} from "forge-std/Test.sol";
import {MarginLens} from "../../src/lens/MarginLens.sol";
import {MarginMath} from "../../src/math/MarginMath.sol";
import {RiskFixture} from "../math/B/B011.t.sol";
contract MarginLensTest is Test {
    MarginLens lens = new MarginLens();
    function testLiveProfileMatchesKernelAndExpiredProfileRequiresBacking() public view {
        MarginMath.RiskParams memory p = RiskFixture.profile(5, true);
        MarginMath.Margin memory m = lens.sideMargin(1_000_000, true, 6e17, 29 days, 100, p);
        MarginMath.Margin memory expected = MarginMath.sideMargin(1_000_000, true, 6e17, 29 days, 100, p);
        assertEq(abi.encode(m), abi.encode(expected));
        assertFalse(m.fullBacking);
        p.realized.validUntil = 100;
        m = lens.sideMargin(1_000_000, true, 6e17, 29 days, 100, p);
        assertTrue(m.fullBacking);
        assertEq(m.capX, 1);
    }
    function testRangeMatchesIndividualCallsAndChecksBounds() public {
        MarginMath.RiskParams memory p = RiskFixture.profile(5, true);
        MarginMath.Health[] memory rows = lens.healthRange(-400e24, 1_000_000, 490, 510, 29 days, 100, p);
        assertEq(rows.length, 21);
        for (uint256 i; i < rows.length; i++) assertEq(abi.encode(rows[i]), abi.encode(lens.health(-400e24, 1_000_000, (490 + i) * 1e15, 29 days, 100, p)));
        vm.expectRevert(); lens.healthRange(0, 1, 0, 10, 29 days, 100, p);
        vm.expectRevert(); lens.healthRange(0, 1, 1, 51, 29 days, 100, p);
    }
}
