// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {FixedPointMathLib as FPM} from "solady/utils/FixedPointMathLib.sol";

/// @title QMath (PROVISIONAL B-lane stand-in)
/// @notice Stand-in for Person A's A009 `contracts/src/math/QMath.sol`, written by B only so the B
///         math libraries compile before G1. Signatures are B's guess of A's published primitives
///         (see docs/merge/B-assumptions.md S-2). Delete at merge and repoint imports to the real
///         QMath. Wide products use solady FixedPointMathLib (already vendored by the book team).
library QMath {
    error QMathDivByZero();
    error QMathOverflow();

    uint256 internal constant WAD = 1e18;
    uint256 internal constant Q = 1e18;

    /// @dev floor(x * y / d) with a 512-bit intermediate; reverts on d == 0 or overflow.
    function mulDivDown(uint256 x, uint256 y, uint256 d) internal pure returns (uint256) {
        if (d == 0) revert QMathDivByZero();
        return FPM.fullMulDiv(x, y, d);
    }

    /// @dev ceil(x * y / d) with a 512-bit intermediate.
    function mulDivUp(uint256 x, uint256 y, uint256 d) internal pure returns (uint256) {
        if (d == 0) revert QMathDivByZero();
        return FPM.fullMulDivUp(x, y, d);
    }

    function divUp(uint256 x, uint256 d) internal pure returns (uint256) {
        if (d == 0) revert QMathDivByZero();
        return x == 0 ? 0 : (x - 1) / d + 1;
    }

    /// @dev floor(sqrt(x)).
    function sqrtDown(uint256 x) internal pure returns (uint256) {
        return FPM.sqrt(x);
    }

    /// @dev ceil(sqrt(x)).
    function sqrtUp(uint256 x) internal pure returns (uint256 r) {
        r = FPM.sqrt(x);
        if (r * r < x) r += 1;
    }

    /// @dev Signed floor division (toward negative infinity). Not truncation.
    function sDivFloor(int256 a, int256 b) internal pure returns (int256 q) {
        if (b == 0) revert QMathDivByZero();
        if (a == type(int256).min && b == -1) revert QMathOverflow();
        q = a / b;
        if ((a % b != 0) && ((a < 0) != (b < 0))) q -= 1;
    }

    /// @dev Signed ceil division (toward positive infinity). Not truncation.
    function sDivCeil(int256 a, int256 b) internal pure returns (int256 q) {
        if (b == 0) revert QMathDivByZero();
        if (a == type(int256).min && b == -1) revert QMathOverflow();
        q = a / b;
        if ((a % b != 0) && ((a < 0) == (b < 0))) q += 1;
    }

    function toInt(uint256 x) internal pure returns (int256) {
        if (x > uint256(type(int256).max)) revert QMathOverflow();
        return int256(x);
    }

    function abs(int256 x) internal pure returns (uint256) {
        if (x == type(int256).min) revert QMathOverflow();
        return uint256(x >= 0 ? x : -x);
    }

    function min(uint256 a, uint256 b) internal pure returns (uint256) {
        return a < b ? a : b;
    }

    function max(uint256 a, uint256 b) internal pure returns (uint256) {
        return a > b ? a : b;
    }
}
