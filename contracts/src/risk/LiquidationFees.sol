// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;
import {TakeoverAccounting} from "./TakeoverAccounting.sol";
import {LedgerMath as L} from "../math/LedgerMath.sol";
import {CoverageMath as C} from "../math/CoverageMath.sol";
import {FeeMath as F} from "../math/FeeMath.sol";
import {QMath as Q} from "../math/QMath.sol";

abstract contract LiquidationFees is TakeoverAccounting {
    /// @dev B authorizes the candidate reduction. A rechecks cash/deficit/fee effects.
    function _liquidationPair(PairInput memory p, address keeper, Context memory c)
        internal
        returns (uint256 chargedQ)
    {
        _live();
        _validateContext(c);
        if (p.lots == 0 || p.buyer == p.seller) revert BadUnits();
        _advanceFunding(c.at, c.freshThrough);
        _touch(p.buyer, c.at);
        _touch(p.seller, c.at);
        Account storage b = accounts[p.buyer];
        Account storage s = accounts[p.seller];
        if (
            b.value.lots >= 0 || s.value.lots <= 0 || p.lots > Q.abs(b.value.lots)
                || p.lots > uint128(s.value.lots)
        ) {
            revert Rejected();
        }
        uint256 fee = uint256(p.lots) * 1e18;
        if (!_reductionsAllowed(p, c, fee)) {
            fee = 0;
            if (!_reductionsAllowed(p, c, 0)) revert Rejected();
        }
        _cancelReservations(p.buyer);
        _cancelReservations(p.seller);
        (uint256 b0, uint256 b1) = _principalDeficits(b);
        (uint256 s0, uint256 s1) = _principalDeficits(s);
        _postPair(p.buyer, p.seller, p.lots, p.tick, fee, fee);
        // _postPair first credits explicit fees; reclassify, never duplicate the credit.
        chargedQ = 2 * fee;
        protocolFeeQ -= chargedQ;
        reserve.cashQ = Q.cash(reserve.cashQ + Q.signed(fee));
        _creditKeeper(keeper, fee);
        _restartSegment(b, c.at, b0, b1);
        _restartSegment(s, c.at, s0, s1);
        _assertCoverage();
    }

    function _reductionsAllowed(PairInput memory p, Context memory c, uint256 fee)
        private
        view
        returns (bool)
    {
        L.Value memory b = accounts[p.buyer].value;
        L.Value memory s = accounts[p.seller].value;
        (L.Value memory nb, L.Value memory ns) = L.fill(b, s, p.lots, p.tick, fee, fee);
        return _allowedReduction(b, nb, c, fee, p.buyer, p.seller)
            && _allowedReduction(s, ns, c, fee, p.seller, p.buyer);
    }

    /// @notice Charge one executed account-side close exactly once; a passive maker
    ///         need not be charged a liquidation fee or be liquidation-eligible.
    function _chargeCloseFee(
        address owner,
        L.Value memory beforeValue,
        uint64 beforeVersion,
        uint64 filled,
        address keeper,
        Context memory c
    ) internal returns (uint256 fee) {
        _live();
        _validateContext(c);
        Account storage a = accounts[owner];
        if (
            filled == 0 || a.positionVersion != beforeVersion + 1 || a.feeChargedVersion == a.positionVersion
                || Q.abs(beforeValue.lots) - Q.abs(a.value.lots) != filled
        ) revert BadState();
        fee = uint256(filled) * 1e18;
        L.Value memory afterFee = L.Value(a.value.lots, Q.cash(a.value.cashQ - Q.signed(fee)));
        if (!_allowedReduction(beforeValue, afterFee, c, fee, owner, address(0))) return 0;
        a.feeChargedVersion = a.positionVersion;
        (uint256 d0, uint256 d1) = _principalDeficits(a);
        a.value = afterFee;
        uint256 keeperPart = fee / 2;
        _creditKeeper(keeper, keeperPart);
        reserve.cashQ = Q.cash(reserve.cashQ + Q.signed(fee - keeperPart));
        _restartSegment(a, c.at, d0, d1);
        _replaceDeficits(a);
        _publishAccount(owner);
        _assertCoverage();
    }

    function _allowedReduction(
        L.Value memory before_,
        L.Value memory after_,
        Context memory c,
        uint256 fee,
        address owner,
        address other
    ) internal view returns (bool) {
        if (
            !c.markAvailable || c.freshThrough < c.at || Q.abs(after_.lots) >= Q.abs(before_.lots)
                || (after_.lots != 0 && (after_.lots > 0) != (before_.lots > 0))
        ) return false;
        C.Orders memory none;
        (uint256 b0, uint256 b1) = C.deficits(before_, none);
        (uint256 a0, uint256 a1) = C.deficits(after_, none);
        if (a0 > b0 || a1 > b1 || L.equity(after_, c.markWad) < 0) return false;
        return _riskAccept(
            Decision(ActionKind.LIQUIDATION, owner, other, before_, after_, none, c.at, c.version, fee)
        );
    }
}
