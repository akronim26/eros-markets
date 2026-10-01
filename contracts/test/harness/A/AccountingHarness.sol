// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;
import {ReserveClaims} from "../../../src/settlement/ReserveClaims.sol";
import {RiskStorage} from "../../../src/risk/RiskStorage.sol";
import {CollateralVault} from "../../../src/vaults/CollateralVault.sol";
import {PremiumMath as P} from "../../../src/math/PremiumMath.sol";
import {CoverageMath as C} from "../../../src/math/CoverageMath.sol";
import {MockRiskDecision} from "../../mocks/A/MockRiskDecision.sol";
import {LedgerMath as L} from "../../../src/math/LedgerMath.sol";

/// @dev Test-only privileged entry points; this harness is not a production engine.
contract AccountingHarness is ReserveClaims {
    // Standard Foundry test marker: size reports must not classify this privileged
    // aggregate fixture (or derived recovery fixtures) as deployable production.
    bool public constant IS_TEST = true;
    MockRiskDecision public immutable decision;
    Context internal context;

    constructor(
        CollateralVault vault,
        MockRiskDecision decision_,
        address treasury_,
        uint64 end,
        bool recovery_,
        bool funding_
    ) RiskStorage(vault, treasury_, end, recovery_, funding_) {
        decision = decision_;
        context = Context(uint64(block.timestamp), uint64(block.timestamp + 30 days), 1, 6e17, true);
    }

    function _riskContext() internal view override returns (Context memory c) {
        c = context;
        c.at = _clock();
    }

    function _riskAccept(Decision memory d) internal view override returns (bool) {
        return decision.check(d);
    }

    function setContext(uint64 fresh, uint256 mark, bool available) external {
        context.freshThrough = fresh;
        context.markWad = mark;
        context.markAvailable = available;
    }

    function activate(int256 rate, P.Tariff memory t) external nonReentrant {
        _activate(rate, t);
    }

    function trade(address buyer, address seller, uint64 lots, uint16 tick, uint256 bf, uint256 sf)
        external
        nonReentrant
    {
        C.Orders memory none;
        _pairedFill(PairInput(buyer, seller, lots, tick, bf, sf, none, none), _checkedContext());
    }

    function sync(address owner) external nonReentrant {
        _live();
        Context memory c = _checkedContext();
        _advanceFunding(c.at, c.freshThrough);
        _touch(owner, c.at);
        _assertCoverage();
    }

    function beginRoll() external nonReentrant {
        _beginRollover(_checkedContext());
    }

    function rollPage(uint8 n) external nonReentrant returns (bool) {
        return _rollPage(n);
    }

    function finishRoll(int256 rate, P.Tariff memory t) external nonReentrant {
        _finishRollover(rate, t, context.freshThrough);
    }

    function setOrders(address owner, C.Orders memory o, uint64 expectedEpoch) external nonReentrant {
        _setReservations(owner, o, expectedEpoch, _checkedContext());
    }

    function cancelOrders(address owner) external nonReentrant {
        _live();
        Context memory c = _checkedContext();
        _advanceFunding(c.at, c.freshThrough);
        _touch(owner, c.at);
        _cancelReservations(owner);
    }

    function releaseOld(address owner, uint64 m, uint64 a, C.Orders memory o) external nonReentrant {
        _releaseOldReservation(owner, m, a, o);
    }

    function takeover(address owner) external nonReentrant {
        _takeover(owner, _checkedContext());
    }

    function liquidationPair(address buyer, address seller, uint64 lots, uint16 tick, address keeper)
        external
        nonReentrant
        returns (uint256)
    {
        C.Orders memory none;
        return
            _liquidationPair(
                PairInput(buyer, seller, lots, tick, 0, 0, none, none), keeper, _checkedContext()
            );
    }

    function singleCloseFee(address buyer, address seller, uint64 lots, uint16 tick, address keeper)
        external
        nonReentrant
        returns (uint256)
    {
        L.Value memory beforeValue = accounts[buyer].value;
        uint64 version = accounts[buyer].positionVersion;
        C.Orders memory none;
        Context memory c = _checkedContext();
        _pairedFill(PairInput(buyer, seller, lots, tick, 0, 0, none, none), c);
        return _chargeCloseFee(buyer, beforeValue, version, lots, keeper, c);
    }

    function beginFloor() external nonReentrant {
        _beginFloor(_checkedContext());
    }

    function floorPage(uint8 n) external nonReentrant returns (bool) {
        return _floorPage(n);
    }

    function freeze(uint64 when) external nonReentrant returns (bool) {
        return _freeze(when, context.freshThrough);
    }

    function snapshotPage(uint8 n) external nonReentrant returns (bool) {
        return _snapshotPage(n);
    }

    function finalPrice(uint256 p, bytes32 id) external nonReentrant returns (bool) {
        return _acceptSettlementPrice(p, id);
    }

    function scanPayout(uint8 n) external nonReentrant returns (bool) {
        return _scanPayoutPage(n);
    }

    function allocatePayout(uint8 n) external nonReentrant returns (bool) {
        return _allocatePayoutPage(n);
    }

    function prepareReserve(uint8 n) external nonReentrant returns (bool) {
        return _prepareReservePage(n);
    }

    function listedRecovery() external nonReentrant {
        _enableListedRecovery();
    }

    function bindBackstop(address pool) external {
        _bindBackstop(pool);
    }

    function registerOnly(address owner) external {
        _register(owner);
    }

    function reserveFill(address owner, bool buys, uint64 lots, uint16 tick) external nonReentrant {
        _reserveFill(owner, buys, lots, tick, _checkedContext());
    }

    function applyBackstop(uint256 n) external nonReentrant returns (uint256) {
        return _applyBackstop(n);
    }
}
