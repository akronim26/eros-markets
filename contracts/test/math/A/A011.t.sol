// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;
import {FundingMath as F} from "../../../src/math/FundingMath.sol";
contract A011Test {
    function testReservePayerAndBudget() public pure {
        F.Delta memory d=F.advance(1,1e16,100,40,1e20);
        assert(d.reservePaymentQ==4e17 && d.traderPayerQ==6e17 && d.flowQ==1e18);
        d=F.advance(80,1,200,0,8000);
        assert(d.secondsAccrued==40 && d.stopped && d.flowQ==8000);
    }
    function testFuzzFundingClears(uint64 oiSeed,int64 reserveSeed,int64 rateSeed) public pure {
        uint256 oi=uint256(oiSeed)%1e9+1;
        int128 r=int128(int256(reserveSeed)%int256(oi));int256 rate=int256(rateSeed)%1e12;
        F.Delta memory d=F.advance(30,rate,oi,r,1e30);
        int256 longs=int256(oi)-(r>0?int256(r):int256(0));
        int256 shorts= -int256(oi)-(r<0?int256(r):int256(0));
        assert(d.reservePaymentQ+longs*d.indexQ+shorts*d.indexQ==0);
    }
}
