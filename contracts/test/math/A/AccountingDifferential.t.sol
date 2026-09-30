// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;
import {ReferenceVectors as V} from "./ReferenceVectors.sol";
import {LedgerMath as L} from "../../../src/math/LedgerMath.sol";
import {PremiumMath as P} from "../../../src/math/PremiumMath.sol";
contract AccountingDifferential {
    function testIndependentLedgerVectors() public pure {
        int256[5][] memory vectors=V.ledger();
        for(uint256 i;i<vectors.length;i++) {
            int256[5] memory v=vectors[i];
            assert(L.equity(L.Value(int128(v[1]),v[0]),uint256(v[2]))==v[3]);
        }
    }
    function testIndependentPremiumBounds() public pure {
        int256[7][] memory vectors=V.premium();
        for(uint256 i;i<vectors.length;i++) {
            int256[7] memory v=vectors[i];
            P.Segment memory s=P.Segment(v[0],int128(v[1]),v[2],0,uint64(uint256(v[4])),uint64(uint256(v[5])));
            uint256 actual=P.cumulative(s,P.Tariff(1e14,1e14,1e18),uint64(uint256(v[3])));
            assert(actual>=uint256(v[6])&&actual-uint256(v[6])<12);
        }
    }
}
