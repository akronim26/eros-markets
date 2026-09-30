// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;
import {QMath as Q} from "./QMath.sol";
import {LedgerMath as L} from "./LedgerMath.sol";
library SettlementMath {
    function rawClaimQ(L.Value memory a,uint256 p) internal pure returns(uint256) { return Q.positive(L.equity(a,p)); }
    function payoutAtoms(uint256 rawQ) internal pure returns(uint256) {return rawQ/1e18;}
    function recoveryAtoms(uint256 rawQ,uint256 totalQ,uint256 availableQ) internal pure returns(uint256) {
        if(totalQ==0)return 0;
        return Q.mulDiv(rawQ,Q.min(totalQ,availableQ),totalQ)/1e18;
    }
    function shareAtoms(uint256 residualAtoms,uint256 shares,uint256 frozenTotal) internal pure returns(uint256) {
        if(frozenTotal==0)return 0;
        return Q.mulDiv(residualAtoms,shares,frozenTotal);
    }
    function backstopAtoms(uint256 seedAtoms,uint256 prefunded,uint256 shortage) internal pure returns(uint256) {
        return Q.min(seedAtoms/5,Q.min(prefunded,shortage));
    }
}
