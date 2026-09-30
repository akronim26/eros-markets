// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;
import {FixedPointMathLib} from "solady/utils/FixedPointMathLib.sol";

library QMath {
    uint256 internal constant Q = 1e18;
    error Bounds();
    function abs(int256 x) internal pure returns (uint256) {
        unchecked { return x < 0 ? uint256(-(x + 1)) + 1 : uint256(x); }
    }
    function signed(uint256 x) internal pure returns (int256) {
        if (x > uint256(type(int256).max)) revert Bounds();
        return int256(x);
    }
    function position(int256 x) internal pure returns (int128) {
        if (abs(x) > 1 << 40) revert Bounds();
        return int128(x);
    }
    function cash(int256 x) internal pure returns (int256) {
        if (abs(x) >= 1 << 180) revert Bounds();
        return x;
    }
    function floorDiv(int256 a, int256 b) internal pure returns (int256 q) {
        q = a / b;
        if (a % b != 0 && ((a < 0) != (b < 0))) --q;
    }
    function ceilDiv(int256 a, int256 b) internal pure returns (int256 q) {
        q = a / b;
        if (a % b != 0 && ((a < 0) == (b < 0))) ++q;
    }
    function mulDiv(uint256 x, uint256 y, uint256 d) internal pure returns (uint256) {
        return FixedPointMathLib.fullMulDiv(x,y,d);
    }
    function mulDivUp(uint256 x, uint256 y, uint256 d) internal pure returns (uint256) {
        return FixedPointMathLib.fullMulDivUp(x,y,d);
    }
    function sqrtUp(uint256 x) internal pure returns (uint256 r) {
        r = FixedPointMathLib.sqrt(x);
        if (r*r < x) ++r;
    }
    function min(uint256 a,uint256 b) internal pure returns(uint256) { return a<b?a:b; }
    function max(uint256 a,uint256 b) internal pure returns(uint256) { return a>b?a:b; }
    function positive(int256 x) internal pure returns(uint256) { return x>0?uint256(x):0; }
}
