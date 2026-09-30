// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;
import {Test} from "forge-std/Test.sol";
import {LedgerMath as L} from "../../../src/math/LedgerMath.sol";
import {QMath as Q} from "../../../src/math/QMath.sol";

contract A010Test is Test {
    function testBilateral() public pure {
        (L.Value memory b, L.Value memory s) =
            L.fill(L.Value(0, 120e24), L.Value(0, 100e24), 1_000_000, 600, 0, 0);
        assert(b.cashQ == -480e24 && s.cashQ == 700e24);
        assert(L.equity(b, 0) == -480e24 && L.equity(b, 1e18) == 520e24);
        assert(L.equity(b, 5e17) + L.equity(s, 5e17) == 220e24);
    }

    function testFuzzPaired(uint64 size, uint16 price) public pure {
        size = uint64(uint256(size) % 1e9 + 1);
        price = uint16(uint256(price) % 999 + 1);
        (L.Value memory b, L.Value memory s) = L.fill(L.Value(0, 0), L.Value(0, 0), size, price, 3, 7);
        assert(b.lots + s.lots == 0);
        assert(b.cashQ + s.cashQ + 10 == 0);
    }

    function testDirectedMath() public pure {
        assert(Q.floorDiv(-7, 3) == -3 && Q.ceilDiv(-7, 3) == -2);
        assert(Q.mulDiv(1 << 200, 1 << 100, 1 << 100) == 1 << 200);
        assert(Q.sqrtUp(type(uint256).max) == 1 << 128);
        assert(Q.abs(type(int256).min) == 1 << 255);
    }
}
