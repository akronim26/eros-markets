// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;
import {EpochRollover} from "./EpochRollover.sol";
import {LedgerMath as L} from "../math/LedgerMath.sol";
import {CoverageMath as C} from "../math/CoverageMath.sol";
import {PremiumMath as P} from "../math/PremiumMath.sol";
import {QMath as Q} from "../math/QMath.sol";

/// @notice A's canonical posting layer. Concrete composition must implement B ports.
abstract contract ClearingCore is EpochRollover {
    function _live() internal view {
        if (!active || halted || work != Work.READY || _clock() >= epoch.end || _clock() >= scheduledT) {
            revert BadState();
        }
        if (_clock() >= scheduledT - 12 hours && !fullBackingReconciled) revert BadState();
    }

    function _activate(int256 rate, P.Tariff memory nextTariff) internal {
        if (active) revert BadState();
        active = true;
        reserveCapBaseQ = uint256(reserve.cashQ);
        reserveVault.activate();
        _openEpoch(rate, nextTariff, _checkedContext().freshThrough);
    }

    function onReserveAllocate(address owner, uint256 atoms) external nonReentrant {
        if (msg.sender != address(collateralVault) || halted || work != Work.READY) revert Unauthorized();
        if (active) {
            _live();
            Context memory c = _checkedContext();
            _advanceFunding(c.at, c.freshThrough);
        }
        uint256 amount = atoms * 1e18;
        allocationQ += amount;
        reserve.cashQ = Q.cash(reserve.cashQ + Q.signed(amount));
        if (!active) reserveVault.mintSeed(owner, atoms);
        _assertCoverage();
    }

    function onAllocate(address owner, uint256 atoms) external nonReentrant {
        if (msg.sender != address(collateralVault) || halted || work != Work.READY) revert Unauthorized();
        uint64 now_ = _clock();
        if (active) {
            _live();
            Context memory c = _checkedContext();
            _advanceFunding(now_, c.freshThrough);
        }
        _register(owner);
        Account storage a = accounts[owner];
        if (active) _touch(owner, now_);
        (uint256 d0, uint256 d1) = _principalDeficits(a);
        a.value.cashQ = Q.cash(a.value.cashQ + Q.signed(atoms * 1e18));
        allocationQ += atoms * 1e18;
        _restartSegment(a, now_, d0, d1);
        _replaceDeficits(a);
        _assertCoverage();
        _publishAccount(owner);
        emit CashAllocated(owner, atoms, a.value.cashQ);
    }

    function release(uint256 atoms) external nonReentrant {
        _live();
        Context memory c = _checkedContext();
        _advanceFunding(c.at, c.freshThrough);
        _touch(msg.sender, c.at);
        Account storage a = accounts[msg.sender];
        L.Value memory next = L.Value(a.value.lots, Q.cash(a.value.cashQ - Q.signed(atoms * 1e18)));
        _requireDecision(
            Decision(ActionKind.RELEASE, msg.sender, address(0), a.value, next, a.orders, c.at, c.version, 0)
        );
        (uint256 d0, uint256 d1) = _principalDeficits(a);
        a.value = next;
        _restartSegment(a, c.at, d0, d1);
        _replaceDeficits(a);
        allocationQ -= atoms * 1e18;
        _publishAccount(msg.sender);
        _assertCoverage();
        collateralVault.release(msg.sender, atoms);
    }

    function _pairedFill(PairInput memory p, Context memory c) internal {
        _live();
        _validateContext(c);
        _advanceFunding(c.at, c.freshThrough);
        _touch(p.buyer, c.at);
        _touch(p.seller, c.at);
        _approveTradePair(p, c);
        Account storage b = accounts[p.buyer];
        Account storage s = accounts[p.seller];
        (uint256 b0, uint256 b1) = _principalDeficits(b);
        (uint256 s0, uint256 s1) = _principalDeficits(s);
        b.orders = p.buyerOrders;
        s.orders = p.sellerOrders;
        _postPair(p.buyer, p.seller, p.lots, p.tick, p.buyerFee, p.sellerFee);
        _restartSegment(b, c.at, b0, b1);
        _restartSegment(s, c.at, s0, s1);
        _assertCoverage();
    }

    function _approveTradePair(PairInput memory p, Context memory c) private view {
        Account storage b = accounts[p.buyer];
        Account storage s = accounts[p.seller];
        (L.Value memory nb, L.Value memory ns) =
            L.fill(b.value, s.value, p.lots, p.tick, p.buyerFee, p.sellerFee);
        _requireDecision(
            Decision(
                ActionKind.TRADE, p.buyer, p.seller, b.value, nb, p.buyerOrders, c.at, c.version, p.buyerFee
            )
        );
        _requireDecision(
            Decision(
                ActionKind.TRADE, p.seller, p.buyer, s.value, ns, p.sellerOrders, c.at, c.version, p.sellerFee
            )
        );
    }

    function _setReservations(address owner, C.Orders memory next, uint64 expectedEpoch, Context memory c)
        internal
    {
        _live();
        _validateContext(c);
        _advanceFunding(c.at, c.freshThrough);
        _touch(owner, c.at);
        Account storage a = accounts[owner];
        if (a.orderEpoch != expectedEpoch) revert Stale();
        _requireDecision(
            Decision(ActionKind.RESERVATION, owner, address(0), a.value, a.value, next, c.at, c.version, 0)
        );
        a.orders = next;
        _replaceDeficits(a);
        _assertCoverage();
    }

    function _cancelReservations(address owner) internal {
        Account storage a = accounts[owner];
        delete a.orders;
        ++a.orderEpoch;
        _replaceDeficits(a);
    }

    function _releaseOldReservation(
        address owner,
        uint64 marketEpoch,
        uint64 accountEpoch,
        C.Orders memory next
    ) internal {
        Account storage a = accounts[owner];
        if (marketEpoch != marketOrderEpoch || accountEpoch != a.orderEpoch) return;
        if (
            next.bidLots > a.orders.bidLots || next.askLots > a.orders.askLots
                || next.bidValueQ > a.orders.bidValueQ || next.askValueQ > a.orders.askValueQ
                || next.feeCapQ > a.orders.feeCapQ
        ) revert BadUnits();
        a.orders = next;
        _replaceDeficits(a);
        _assertCoverage();
    }

    function _reserveFill(address owner, bool reserveBuys, uint64 lots, uint16 tick, Context memory c)
        internal
    {
        _live();
        _validateContext(c);
        _advanceFunding(c.at, c.freshThrough);
        _touch(owner, c.at);
        if (lots == 0 || lots > Q.abs(reserve.lots) || (reserveBuys ? reserve.lots >= 0 : reserve.lots <= 0))
        {
            revert Rejected();
        }
        Account storage a = accounts[owner];
        L.Value memory nr;
        L.Value memory na;
        if (reserveBuys) (nr, na) = L.fill(reserve, a.value, lots, tick, 0, 0);
        else (na, nr) = L.fill(a.value, reserve, lots, tick, 0, 0);
        _requireDecision(
            Decision(
                ActionKind.RESERVE_UNWIND, owner, address(this), a.value, na, a.orders, c.at, c.version, 0
            )
        );
        (uint256 d0, uint256 d1) = _principalDeficits(a);
        oiAllLots -= _positiveLots(reserve.lots) + _positiveLots(a.value.lots);
        reserve = nr;
        a.value = na;
        oiAllLots += _positiveLots(nr.lots) + _positiveLots(na.lots);
        ++a.positionVersion;
        _restartSegment(a, c.at, d0, d1);
        _replaceDeficits(a);
        _publishAccount(owner);
        _assertCoverage();
    }
}
