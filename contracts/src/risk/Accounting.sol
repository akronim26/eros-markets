// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;
import {FeeAccounting} from "./FeeAccounting.sol";
import {LedgerMath as L} from "../math/LedgerMath.sol";
import {QMath as Q} from "../math/QMath.sol";

abstract contract Accounting is FeeAccounting {
    function _positiveLots(int128 n) internal pure returns (uint256) {
        return Q.positive(n);
    }

    function _postPair(address buyer, address seller, uint64 lots, uint16 tick, uint256 bFee, uint256 sFee)
        internal
    {
        if (buyer == seller || !registered[buyer] || !registered[seller]) revert BadUnits();
        Account storage b = accounts[buyer];
        Account storage s = accounts[seller];
        oiAllLots -= _positiveLots(b.value.lots) + _positiveLots(s.value.lots);
        (b.value, s.value) = L.fill(b.value, s.value, lots, tick, bFee, sFee);
        oiAllLots += _positiveLots(b.value.lots) + _positiveLots(s.value.lots);
        if (oiAllLots > 1 << 40) revert BadUnits();
        ++b.positionVersion;
        ++s.positionVersion;
        protocolFeeQ += bFee + sFee;
        _replaceDeficits(b);
        _replaceDeficits(s);
        _publishAccount(buyer);
        _publishAccount(seller);
        emit PairedPosting(buyer, seller, lots, tick, bFee + sFee);
    }
}
