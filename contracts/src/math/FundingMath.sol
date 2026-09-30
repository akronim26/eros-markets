// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;
import {QMath as Q} from "./QMath.sol";
library FundingMath {
    struct Delta { uint64 secondsAccrued; int256 indexQ; uint256 flowQ; int256 reservePaymentQ; uint256 traderPayerQ; bool stopped; }
    error Domain();
    function rate(uint256 markWad,uint256 indexWad) internal pure returns(int256 r) {
        if(markWad>1e18||indexWad==0||indexWad>=1e18) revert Domain();
        int256 basis=int256(markWad)-int256(indexWad);
        int256 cap=int256(Q.min(indexWad,1e18-indexWad)/20);
        if(basis>cap) basis=cap;if(basis< -cap) basis= -cap;
        return basis*1000/86400;
    }
    function authorization(uint256 oi,int256 r,uint64 secondsLeft,uint256 slackQ) internal pure returns(uint256) {
        return Q.min(oi*Q.abs(r)*secondsLeft,slackQ);
    }
    function advance(uint64 elapsed,int256 r,uint256 oi,int128 reserveLots,uint256 budget) internal pure returns(Delta memory d) {
        if(oi<Q.abs(reserveLots)) revert Domain();
        if(oi==0||r==0) { d.stopped=true;return d; }
        uint256 perSecond=oi*Q.abs(r);
        uint256 affordable=budget/perSecond;
        d.secondsAccrued=uint64(Q.min(elapsed,affordable));
        d.indexQ=r*int256(uint256(d.secondsAccrued));
        d.flowQ=perSecond*d.secondsAccrued;
        d.reservePaymentQ=int256(reserveLots)*d.indexQ;
        d.traderPayerQ=d.flowQ-Q.positive(d.reservePaymentQ);
        d.stopped=affordable<=elapsed;
    }
}
