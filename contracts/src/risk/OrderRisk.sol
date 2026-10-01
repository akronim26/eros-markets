// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {MathTypes} from "../math/MathTypes.sol";
import {IAccountingPort} from "../interfaces/IAccountingPort.sol";
import {OrderAdmissionMath as OA} from "../math/OrderAdmissionMath.sol";

/// @title OrderRisk
/// @notice Generation-scoped order reservations (spec §7.2–7.3, §7.5 `_riskOnUnrest`; B022).
///         Per account: exact bid/ask lots, value in Q (lots * tick * Q), fee commitment and
///         conservative price extrema, all tagged with the full uint64 (market, account) order
///         epoch they belong to. Per slot: a sidecar with the full epochs, reduce version and fee
///         attribution, protected by the slot generation.
/// @dev An old epoch tag is a no-op for current sums: stale nodes pruned lazily can never subtract
///      a newer reservation. A stale stored tag is cleared on the first touch in a newer epoch and
///      the account's contribution is replaced once. Underflow or a wrong tick reverts (never
///      saturates). Every change replaces the account contribution through Person A's port.
abstract contract OrderRisk is IAccountingPort {
    error SidecarGenerationMismatch();
    error StaleEpochMutation();

    struct Reservation {
        OA.OrderSums sums;
        uint64 marketEpoch;
        uint64 accountEpoch;
    }

    struct Sidecar {
        uint24 generation;
        uint32 owner;
        MathTypes.Side side;
        uint16 tick;
        uint64 marketEpoch;
        uint64 accountEpoch;
        uint64 reduceVersion;
        uint256 feeCapQ;
        bool reduceOnly;
    }

    mapping(uint32 trader => Reservation) internal _res;
    mapping(uint32 slot => Sidecar) internal _sidecars;

    event ReservationChanged(
        uint32 indexed trader,
        uint128 bidLots,
        uint256 bidValueQ,
        uint128 askLots,
        uint256 askValueQ,
        uint256 feeCapQ,
        uint64 marketEpoch,
        uint64 accountEpoch
    );

    function _currentTag(uint32 trader) internal view returns (uint64 m, uint64 a) {
        m = _acctMarketOrderEpoch();
        a = _acctAccount(trader).orderEpoch;
    }

    function _isCurrent(uint32 trader, uint64 m, uint64 a) internal view returns (bool) {
        (uint64 cm, uint64 ca) = _currentTag(trader);
        return m == cm && a == ca;
    }

    /// @notice Current-epoch reservation sums; a stale stored epoch reads as empty.
    function _resSums(uint32 trader) internal view returns (OA.OrderSums memory) {
        Reservation storage r = _res[trader];
        if (!_isCurrent(trader, r.marketEpoch, r.accountEpoch)) return OA.emptySums();
        return r.sums;
    }

    /// @notice Clear a stale stored epoch once (on touch) and replace the contribution.
    function _resSyncEpoch(uint32 trader) internal returns (bool cleared) {
        Reservation storage r = _res[trader];
        (uint64 m, uint64 a) = _currentTag(trader);
        if (r.marketEpoch == m && r.accountEpoch == a) return false;
        r.sums = OA.emptySums();
        (r.marketEpoch, r.accountEpoch) = (m, a);
        _commit(trader, r);
        return true;
    }

    function _resAdd(uint32 trader, bool isBid, uint16 tick, uint64 lots, uint256 feeCapQ)
        internal
        returns (uint64 m, uint64 a)
    {
        _resSyncEpoch(trader);
        Reservation storage r = _res[trader];
        r.sums = OA.addOrder(r.sums, isBid, lots, tick, feeCapQ);
        _commit(trader, r);
        return (r.marketEpoch, r.accountEpoch);
    }

    /// @notice Release a resting reservation (cancel/expiry/prune/amend-down). Returns false and
    ///         changes nothing when the order's epoch is no longer current.
    function _resRemove(
        uint32 trader,
        uint64 m,
        uint64 a,
        bool isBid,
        uint16 tick,
        uint64 lots,
        uint256 feeCapQ
    ) internal returns (bool applied) {
        Reservation storage r = _res[trader];
        if (!_isCurrent(trader, m, a) || r.marketEpoch != m || r.accountEpoch != a) return false;
        r.sums = OA.removeOrder(r.sums, isBid, lots, tick, feeCapQ);
        _commit(trader, r);
        return true;
    }

    /// @notice Consume the filled part of a current-epoch maker reservation at its limit tick.
    function _resConsumeFill(uint32 trader, bool isBid, uint16 tick, uint64 lots, uint256 feeCapQ) internal {
        Reservation storage r = _res[trader];
        if (!_isCurrent(trader, r.marketEpoch, r.accountEpoch)) revert StaleEpochMutation();
        r.sums = OA.removeOrder(r.sums, isBid, lots, tick, feeCapQ);
        _commit(trader, r);
    }

    /// @notice Cancel-all: bump the account order epoch (A storage), clear sums, replace once.
    function _resCancelAll(uint32 trader) internal returns (uint64 m, uint64 a) {
        _acctBumpAccountOrderEpoch(trader);
        _resSyncEpoch(trader);
        Reservation storage r = _res[trader];
        return (r.marketEpoch, r.accountEpoch);
    }

    function _commit(uint32 trader, Reservation storage r) private {
        _acctReplaceContribution(trader, r.sums);
        emit ReservationChanged(
            trader,
            r.sums.bidLots,
            r.sums.bidValueQ,
            r.sums.askLots,
            r.sums.askValueQ,
            r.sums.feeCapQ,
            r.marketEpoch,
            r.accountEpoch
        );
    }

    // ------------------------------------------------------------------ sidecar

    /// @notice Overwrite the slot's sidecar on (re)use; the generation guards every later read.
    function _sidecarWrite(uint32 slot, Sidecar memory s) internal {
        _sidecars[slot] = s;
    }

    function _sidecarRead(uint32 slot, uint24 generation) internal view returns (Sidecar memory s) {
        s = _sidecars[slot];
        if (s.generation != generation) revert SidecarGenerationMismatch();
    }

    function _sidecarUpdateFee(uint32 slot, uint24 generation, uint256 feeCapQ) internal {
        Sidecar storage s = _sidecars[slot];
        if (s.generation != generation) revert SidecarGenerationMismatch();
        s.feeCapQ = feeCapQ;
    }

    function reservation(uint32 trader)
        external
        view
        returns (OA.OrderSums memory sums, uint64 m, uint64 a)
    {
        Reservation storage r = _res[trader];
        return (r.sums, r.marketEpoch, r.accountEpoch);
    }
}
