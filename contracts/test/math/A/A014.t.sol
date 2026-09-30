// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;
import {SettlementMath as S} from "../../../src/math/SettlementMath.sol";
contract A014Test {
    function testRecoveryAndFrozenShares() public pure {
        assert(S.recoveryAtoms(3e18,10e18,5e18)==1);
        assert(S.recoveryAtoms(7e18,10e18,5e18)==3);
        assert(S.recoveryAtoms(0,0,0)==0);
        assert(S.shareAtoms(89,1,3)==29&&S.shareAtoms(89,2,3)==59);
        assert(S.backstopAtoms(100,1000,50)==20);
    }
}
