// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Stage, PricingMode, AccountingState} from "../math/RiskTypes.sol";
import {LiquidationMath as LM} from "../math/LiquidationMath.sol";
import {MarginMath} from "../math/MarginMath.sol";
import {OrderAdmissionMath as OA} from "../math/OrderAdmissionMath.sol";
import {RiskContext} from "../pricing/RiskPricing.sol";
import {RiskLiquidation} from "./RiskLiquidation.sol";

/// @title RiskView
/// @notice Complete risk / stage / progress / rejection read model (spec §5.4; B032). Views
///         recompute from Person A's (virtually settled) account values and the current context;
///         they hold no alternative cash ledger. Units are in field-name suffixes; an unavailable
///         price is flagged, never 0; pending work is reported explicitly.
abstract contract RiskView is RiskLiquidation {
    uint8 public constant PENDING_FLOOR_SWEEP = 1;
    uint8 public constant PENDING_ROLLOVER_SWEEP = 2;
    uint8 public constant PENDING_HALT_SWEEP = 4;
    uint8 public constant PENDING_EPOCH_OPENING = 8;

    struct AccountRiskView {
        uint32 trader;
        uint64 asOfTime;
        Stage stage;
        int256 cashQ;
        int256 positionLots;
        int256 e0Q;
        int256 e1Q;
        bool markAvailable;
        int256 markEquityQ; // meaningful only when markAvailable
        uint256 mmQ;
        uint256 imQ;
        MarginMath.Status status;
        bool graceActive;
        uint64 graceEndsAt;
        LM.Mode liquidationMode;
        uint8 takeoverPredicate;
        OA.OrderSums orders;
    }

    struct MarketRiskView {
        uint64 asOfTime;
        Stage stage;
        PricingMode pricingMode;
        AccountingState accountingState;
        bool indexAvailable;
        uint256 indexWad;
        bool markAvailable;
        uint256 markWad;
        uint64 riskVersion;
        bytes32 profileHash;
        uint64 secsToT;
        bool monitorRestricted;
        uint64 fundingFreshThrough;
        FloorStatus floorStatus;
        uint64 floorCursor;
        uint64 floorCount;
        uint64 liquidationCapLots;
        uint64 liquidationRemainingLots;
        uint8 pendingWork; // bitmask of PENDING_*
    }

    function accountRiskView(uint32 trader) external view returns (AccountRiskView memory v) {
        RiskContext memory c = _pricingContext();
        AccountView memory a = _acctAccount(trader);
        v.trader = trader;
        v.asOfTime = c.economicTime;
        v.stage = c.stage;
        (v.cashQ, v.positionLots) = (a.cashQ, a.lots);
        v.orders = _resSums(trader);
        Eligibility memory el = _eligibility(trader, c);
        (v.e0Q, v.e1Q, v.liquidationMode, v.takeoverPredicate) =
            (el.e0Q, el.e1Q, el.mode, el.takeoverPredicate);
        v.markAvailable = c.markOk;
        if (c.markOk) {
            (, MarginMath.Health memory h) = _health(trader, c);
            (v.markEquityQ, v.mmQ, v.imQ, v.status) = (h.markEquityQ, h.mmQ, h.imQ, h.status);
        }
        v.graceActive = _grace[trader].active;
        if (v.graceActive) {
            uint64 end = _grace[trader].anchor + GRACE_SECS;
            uint64 floorAt = c.scheduledT - 43_200;
            v.graceEndsAt = end < floorAt ? end : floorAt;
        }
    }

    function marketRiskView() external view returns (MarketRiskView memory v) {
        RiskContext memory c = _pricingContext();
        v.asOfTime = c.economicTime;
        v.stage = c.stage;
        v.pricingMode = c.pricingMode;
        v.accountingState = _acctAccountingState();
        (v.indexAvailable, v.indexWad, v.markAvailable, v.markWad) =
            (c.indexOk, c.indexWad, c.markOk, c.markWad);
        (v.riskVersion, v.profileHash, v.secsToT) = (c.riskVersion, c.profileHash, c.secsToT);
        (v.monitorRestricted, v.fundingFreshThrough) = (c.monitorRestricted, c.fundingFreshThrough);
        (v.floorStatus, v.floorCursor, v.floorCount) = (_floorStatus, _floorCursor, _floorCount);
        (v.liquidationCapLots, v.liquidationRemainingLots) = (_listing.maxLiqLotsPerBlock, _blockRemaining());
        if (c.fundingFrozen && !c.halted && _floorStatus != FloorStatus.RECONCILED) {
            v.pendingWork |= PENDING_FLOOR_SWEEP;
        }
        if (v.accountingState == AccountingState.ROLLOVER_SWEEP) v.pendingWork |= PENDING_ROLLOVER_SWEEP;
        if (v.accountingState == AccountingState.HALT_SWEEP) v.pendingWork |= PENDING_HALT_SWEEP;
        if (_hasStagedProfile) v.pendingWork |= PENDING_EPOCH_OPENING;
    }
}
