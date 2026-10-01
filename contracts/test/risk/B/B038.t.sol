// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {ConversionGate} from "../../../src/settlement/ConversionGate.sol";
import {LifecycleMath} from "../../../src/math/LifecycleMath.sol";
import {SettlementView} from "../../../src/interfaces/IResolutionIngress.sol";
import {IMarketConfig} from "../../../src/interfaces/IMarketConfig.sol";
import {MarginMath} from "../../../src/math/MarginMath.sol";
import {IAccountingPort} from "../../../src/interfaces/IAccountingPort.sol";
import {MockAccountingPort} from "../../mocks/B/MockAccountingPort.sol";
import {MockBookAdapter} from "../../mocks/B/MockBookAdapter.sol";
import {MockResolutionAuthority} from "../../mocks/B/MockResolutionAuthority.sol";
import {AdmissionMode} from "../../../src/math/RiskTypes.sol";
import {ListingFixture} from "./B019.t.sol";
import {RiskFixture} from "../../math/B/B011.t.sol";

contract GateEngine is ConversionGate, MockBookAdapter, MockAccountingPort {
    bool public enabledForTest; // only the test variant flips this; baseline stays false

    function init(IMarketConfig.Listing memory l, MarginMath.RiskParams memory p) external {
        _initMarket(l, p);
    }

    function _liqSubmitIoc(OrderRequest memory req) internal override returns (uint64, uint256) {
        PlaceResult memory r = _mockPlaceWithMode(req, AdmissionMode.FORCED_REDUCTION);
        return (r.filledLots, lastExamined);
    }

    function _conversionEnabled() internal view override returns (bool) {
        return enabledForTest;
    }

    function enableForTest() external {
        enabledForTest = true;
    }

    function cashClaim() external {
        _riskBeforeCashClaim();
    }
}

/// B038: conversion stays fenced; cash/token claims are mutually exclusive; UI readiness.
contract B038Test is Test {
    uint64 constant L0 = 1_000_000;
    GateEngine e;
    MockResolutionAuthority oracle;

    function setUp() public {
        vm.warp(L0);
        oracle = new MockResolutionAuthority();
        e = new GateEngine();
        IMarketConfig.Listing memory l =
            ListingFixture.make(L0, address(oracle), address(0x30), address(0x60), address(0x51));
        e.init(l, RiskFixture.profile(5, true));
        oracle.bind(e);
        e.mockSetAccount(1, 1e24, 0);
        e.mockScriptFreeze(IAccountingPort.FreezeResult(0, 0, 0, 0, 1, 0, bytes32(0), bytes32(0)));
        e.mockScriptFinish(IAccountingPort.FinishResult(true, false, 1, 0));
        vm.warp(L0 + 2 days);
        oracle.finalize(1);
        e.prepareSnapshotChunk(32);
    }

    function test_baselineDisabled() public {
        e.mockSetClaimState(false, false, true);
        assertEq(e.conversionEligibility(), e.R_DISABLED());
        vm.expectRevert(ConversionGate.ConversionDisabled.selector);
        e.selectConversionMode();
    }

    function test_noTokenPathAfterCashClaim() public {
        e.enableForTest();
        e.mockSetClaimState(false, true, true);
        assertEq(e.conversionEligibility(), e.R_CASH_CLAIM_STARTED());
        vm.expectRevert(abi.encodeWithSelector(ConversionGate.ConversionNotEligible.selector, uint8(3)));
        e.selectConversionMode();
    }

    function test_noTokenPathWithUnderbacking() public {
        e.enableForTest();
        e.mockSetClaimState(false, false, false); // some account (or the reserve) underbacked
        assertEq(e.conversionEligibility(), e.R_UNDERBACKED());
        vm.expectRevert(abi.encodeWithSelector(ConversionGate.ConversionNotEligible.selector, uint8(4)));
        e.selectConversionMode();
    }

    function test_modesMutuallyExclusive() public {
        e.enableForTest();
        e.mockSetClaimState(false, false, true);
        e.selectConversionMode();
        assertEq(uint8(e.claimMode()), uint8(ConversionGate.ClaimMode.CONVERSION));
        vm.expectRevert(ConversionGate.CashClaimsClosedByConversion.selector);
        e.cashClaim();
    }

    function test_cashFirstLocksOutConversion() public {
        e.enableForTest();
        e.mockSetClaimState(false, false, true);
        e.cashClaim();
        assertEq(uint8(e.claimMode()), uint8(ConversionGate.ClaimMode.CASH));
        assertEq(e.conversionEligibility(), e.R_MODE_SELECTED());
    }

    function test_oracleFinalNotClaimableWithoutReadiness() public {
        SettlementView memory v = e.getSettlementStatus();
        assertTrue(v.oracleFinalityAccepted);
        assertFalse(v.claimsEnabled);
        assertEq(uint8(e.claimsStatus()), uint8(LifecycleMath.ClaimsStatus.ORACLE_FINAL_PREPARING));
        e.preparePayoutChunk(32);
        e.finishPreparation();
        assertTrue(e.getSettlementStatus().claimsEnabled);
        assertEq(uint8(e.claimsStatus()), uint8(LifecycleMath.ClaimsStatus.CLAIMABLE));
    }
}
