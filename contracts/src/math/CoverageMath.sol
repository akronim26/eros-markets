// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;
import {QMath as Q} from "./QMath.sol";
import {LedgerMath as L} from "./LedgerMath.sol";
library CoverageMath {
    struct Orders { uint128 bidLots; uint256 bidValueQ; uint128 askLots; uint256 askValueQ; uint256 feeCapQ; }
    function deficits(L.Value memory a,Orders memory o) internal pure returns(uint256 d0,uint256 d1) {
        int256 c=a.cashQ-Q.signed(o.feeCapQ);
        d0=Q.positive(Q.signed(o.bidValueQ)-c);
        d1=Q.positive(-(c+int256(a.lots)*1000e18-Q.signed(uint256(o.askLots)*1000e18)+Q.signed(o.askValueQ)));
    }
    function slacks(L.Value memory reserve,uint256 d0,uint256 d1,uint256 cushion,uint256 budget)
        internal pure returns(int256 s0,int256 s1) {
        (s0,s1)=L.endpoints(reserve);
        s0-=Q.signed(d0+cushion+budget);s1-=Q.signed(d1+cushion+budget);
    }
    function concentration(uint256 d0,uint256 d1,uint256 seedQ) internal pure returns(bool) {
        return Q.max(d0,d1)<=seedQ/50;
    }
}
