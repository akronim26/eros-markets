// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;
import {ClearingCore} from "./ClearingCore.sol";
import {LedgerMath as L} from "../math/LedgerMath.sol";
import {QMath as Q} from "../math/QMath.sol";

abstract contract TakeoverAccounting is ClearingCore {
    function _takeover(address owner, Context memory c) internal {
        _live();
        _validateContext(c);
        _advanceFunding(c.at, c.freshThrough);
        _touch(owner, c.at);
        Account storage a = accounts[owner];
        (int256 e0, int256 e1) = L.endpoints(a.value);
        bool floorDeficit = c.at >= scheduledT - 12 hours && (e0 < 0 || e1 < 0);
        bool nonpositiveEndpoints = e0 <= 0 && e1 <= 0;
        bool nonpositiveMark = c.markAvailable && c.freshThrough >= c.at && c.markWad > 0 && c.markWad < 1e18
            && L.equity(a.value, c.markWad) <= 0;
        if (!floorDeficit && !nonpositiveEndpoints && !nonpositiveMark) revert Rejected();
        L.Value memory zero;
        _requireDecision(
            Decision(ActionKind.TAKEOVER, owner, address(0), a.value, zero, a.orders, c.at, c.version, 0)
        );
        _takeoverPosted(owner, c.at);
    }

    function _takeoverPosted(address owner, uint64 cutoff) internal {
        Account storage a = accounts[owner];
        L.Value memory value = a.value;
        _cancelReservations(owner);
        oiAllLots -= _positiveLots(a.value.lots) + _positiveLots(reserve.lots);
        reserve = L.takeover(value, reserve);
        delete a.value;
        oiAllLots += _positiveLots(reserve.lots);
        a.premiumPaid = 0;
        a.segmentPosted = 0;
        a.segmentCash = 0;
        a.segmentStart = cutoff;
        a.surchargeUntil = 0;
        ++a.positionVersion;
        _replaceDeficits(a);
        _assertCoverage();
        _publishAccount(owner);
        emit AccountTakenOver(owner, value.lots, value.cashQ, cutoff);
    }
}
