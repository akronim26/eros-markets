// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;
import {CoverageMath as C} from "../../../src/math/CoverageMath.sol";
import {LedgerMath as L} from "../../../src/math/LedgerMath.sol";
import {FeeMath as F} from "../../../src/math/FeeMath.sol";
contract A013Test {
    function testOversizedAskAndFees() public pure {
        C.Orders memory o=C.Orders(0,0,2300,2300*550e18,0);
        (uint256 d0,uint256 d1)=C.deficits(L.Value(1000,0),o);
        assert(d0==0&&d1==35000e18);
        uint256 total;
        for(uint64 i;i<17;i++)total+=F.fragment(10421,17,i,i+1);
        assert(total==10421);
        (uint256 r,uint256 k)=F.liquidation(1);assert(r==5e17&&k==5e17);
    }
}
