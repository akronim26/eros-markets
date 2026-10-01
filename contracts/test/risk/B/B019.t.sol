// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {RiskContextPort} from "../../../src/risk/RiskContextPort.sol";
import {IMarketConfig} from "../../../src/interfaces/IMarketConfig.sol";
import {IResolutionEngine, OracleOutcomeMap} from "../../../src/interfaces/IResolutionIngress.sol";
import {MarginMath} from "../../../src/math/MarginMath.sol";
import {OrderAdmissionMath as OA} from "../../../src/math/OrderAdmissionMath.sol";
import {RejectCode, PricingMode} from "../../../src/math/RiskTypes.sol";
import {MathTypes} from "../../../src/math/MathTypes.sol";
import {RiskFixture} from "../../math/B/B011.t.sol";

/// @dev Shared B test listing (local fixture profile, spec §5.4). Times relative to `listedAt`.
library ListingFixture {
    function make(uint64 listedAt, address oracle, address monitor, address gov, address signer)
        internal
        pure
        returns (IMarketConfig.Listing memory l)
    {
        l.marketId = keccak256("eros-market-1");
        l.token = address(0x05DC);
        l.registry = address(0x5E6);
        l.resolutionAuthority = oracle;
        l.monitor = monitor;
        l.governance = gov;
        l.listedAt = listedAt;
        l.scheduledT = listedAt + 10 days;
        l.sourceHash = keccak256("source");
        l.rulesHash = keccak256("rules");
        l.invalidRule = IMarketConfig.InvalidRule(true, 3600, 5e17, 30 days);
        l.template = MarginMath.Template.SCHEDULED;
        l.deploymentCapX = 5; // fixture-only leverage
        l.maxTraders = 1024;
        l.indexSourceId = keccak256("index-source");
        l.indexSigner = signer;
        l.indexRulesHash = keccak256("index-rules");
        l.depthNLots = 500;
        l.maxSpreadWad = 5e16;
        l.bootstrapBandWad = 5e16;
        l.minOrderLots = 1;
        l.maxOrderLots = uint64(type(uint32).max);
        l.maxLiqLotsPerBlock = 10_000_000;
        l.fundingEnabled = true;
    }
}

contract PortHarness is RiskContextPort {
    function init(IMarketConfig.Listing memory l, MarginMath.RiskParams memory p) external {
        _initMarket(l, p);
    }

    /// Stand-in for B034: authority check then explicit mapping; returns the local outcome.
    function oracleSettle(uint8 oracleOutcome) external view returns (MathTypes.FinalOutcome) {
        _onlyResolutionAuthority();
        (OracleOutcomeMap.EngineCall call, uint8 y) = OracleOutcomeMap.engineCallFor(oracleOutcome);
        if (call == OracleOutcomeMap.EngineCall.SETTLE_INVALID) return MathTypes.FinalOutcome.INVALID;
        return OracleOutcomeMap.localOutcome(y);
    }

    function epochOpened() external {
        _riskEpochOpened();
    }

    function index(uint64 t, uint256 p) external {
        _onIndexObservation(t, p, true);
    }

    function release(ReleaseInput memory r) external view returns (bool, RejectCode) {
        return _riskReleaseDecision(r);
    }

    function cutoffs(uint64 epochEnd, uint64 stopAt, uint64 frozen) external view returns (uint64, uint64) {
        return (_riskAccrualCutoff(epochEnd, frozen), _riskFundingCutoff(epochEnd, stopAt, frozen));
    }

    function paramsHash() external view returns (bytes32) {
        return profileHashOf(_riskParams());
    }
}

/// B019: config, authority and boundary ports.
contract B019Test is Test {
    address constant ORACLE = address(0x0AC1E);
    address constant MONITOR = address(0x3031);
    address constant GOV = address(0x6007);
    address constant SIGNER = address(0x516);
    PortHarness h;
    IMarketConfig.Listing l;

    function setUp() public {
        vm.warp(1000);
        h = new PortHarness();
        l = ListingFixture.make(1000, ORACLE, MONITOR, GOV, SIGNER);
    }

    function test_validListingInitializesOnce() public {
        h.init(l, RiskFixture.profile(5, true));
        assertEq(h.listingHash(), keccak256(abi.encode(l)));
        assertEq(h.listing().scheduledT, l.scheduledT);
        vm.expectRevert(RiskContextPort.AlreadyInitialized.selector);
        h.init(l, RiskFixture.profile(5, true));
    }

    function test_listingHorizonGate() public view {
        IMarketConfig.Listing memory x = l;
        x.scheduledT = x.listedAt + 1 days - 1;
        (bool ok, uint8 r) = h.validateListing(x);
        assertFalse(ok);
        assertEq(r, 1);
        x.scheduledT = x.listedAt + 30 days - 3600; // T + grace == listedAt + void
        (ok,) = h.validateListing(x);
        assertTrue(ok);
        x.scheduledT += 1;
        (ok, r) = h.validateListing(x);
        assertFalse(ok);
        assertEq(r, 2);
    }

    function test_fallbackRuleFixed() public view {
        IMarketConfig.Listing memory x = l;
        x.invalidRule.fallbackPriceWad = 4e17;
        (bool ok, uint8 r) = h.validateListing(x);
        assertFalse(ok);
        assertEq(r, 3);
        x.invalidRule = IMarketConfig.InvalidRule(false, 0, 0, 30 days); // legacy: no fallback
        (ok,) = h.validateListing(x);
        assertTrue(ok);
    }

    function test_boundsAndAddresses() public view {
        IMarketConfig.Listing memory x = l;
        x.maxTraders = 1025;
        (bool ok,) = h.validateListing(x);
        assertFalse(ok);
        x = l;
        x.maxOrderLots = uint64(type(uint48).max) + 1;
        (ok,) = h.validateListing(x);
        assertFalse(ok, "packed book range");
        x = l;
        x.resolutionAuthority = address(0);
        (ok,) = h.validateListing(x);
        assertFalse(ok);
    }

    function test_outcomeMappingNeverCasts() public {
        h.init(l, RiskFixture.profile(5, true));
        vm.startPrank(ORACLE);
        // external YES = 1 -> settle(1) -> local YES = 2; external NO = 2 -> settle(0) -> local NO = 1
        assertEq(uint8(h.oracleSettle(1)), uint8(MathTypes.FinalOutcome.YES));
        assertEq(uint8(MathTypes.FinalOutcome.YES), 2);
        assertEq(uint8(h.oracleSettle(2)), uint8(MathTypes.FinalOutcome.NO));
        assertEq(uint8(MathTypes.FinalOutcome.NO), 1);
        assertEq(uint8(h.oracleSettle(3)), uint8(MathTypes.FinalOutcome.INVALID));
        assertEq(uint8(h.oracleSettle(4)), uint8(MathTypes.FinalOutcome.INVALID), "voided is INVALID");
        vm.expectRevert(OracleOutcomeMap.NoEngineCall.selector);
        h.oracleSettle(0);
        vm.stopPrank();
    }

    function test_wrongRoleCannotChooseOutcome() public {
        h.init(l, RiskFixture.profile(5, true));
        address[4] memory who = [MONITOR, GOV, SIGNER, address(0xBAD)];
        for (uint256 i; i < 4; ++i) {
            vm.prank(who[i]);
            vm.expectRevert(RiskContextPort.Unauthorized.selector);
            h.oracleSettle(1);
        }
    }

    function test_oracleCannotRewriteRulesOrCalibration() public {
        h.init(l, RiskFixture.profile(5, true));
        bytes32 before = h.listingHash();
        vm.prank(ORACLE);
        vm.expectRevert(RiskContextPort.Unauthorized.selector);
        h.stageRiskParams(RiskFixture.profile(1, true));
        vm.prank(ORACLE);
        h.oracleSettle(1);
        assertEq(h.listingHash(), before);
    }

    function test_calibrationVersionedAtEpoch() public {
        h.init(l, RiskFixture.profile(5, true));
        bytes32 h1 = h.paramsHash();
        vm.prank(GOV);
        h.stageRiskParams(RiskFixture.profile(3, true));
        assertEq(h.paramsHash(), h1, "not active before the epoch opening");
        assertEq(h.activeProfile().version, 1);
        h.epochOpened();
        assertEq(h.activeProfile().version, 2);
        assertEq(h.paramsHash(), h.profileHashOf(RiskFixture.profile(3, true)));
        assertEq(h.activeProfile().profileHash, h.paramsHash());
    }

    function test_resolutionAbiMatchesSpec() public pure {
        assertEq(IResolutionEngine.halt.selector, bytes4(keccak256("halt()")));
        assertEq(IResolutionEngine.settle.selector, bytes4(keccak256("settle(uint8)")));
        assertEq(IResolutionEngine.settleInvalid.selector, bytes4(keccak256("settleInvalid()")));
        assertEq(
            IResolutionEngine.materializeScheduledHalt.selector,
            bytes4(keccak256("materializeScheduledHalt()"))
        );
        assertEq(IResolutionEngine.getHaltSnapshot.selector, bytes4(keccak256("getHaltSnapshot()")));
        assertEq(IResolutionEngine.getSettlementStatus.selector, bytes4(keccak256("getSettlementStatus()")));
    }

    function test_releaseDecision() public {
        h.init(l, RiskFixture.profile(5, true));
        for (uint64 t = 1000; t <= 1400; t += 10) {
            h.index(t, 6e17);
        }
        vm.warp(1400);
        // bootstrap: no normal mark -> only exactly backed releases
        RiskContextPort.ReleaseInput memory r;
        r.coverageAfter = OA.CoverageInput(0, 0, 2000e24, true);
        r.sums = OA.emptySums();
        r.cashAfterQ = 1e24;
        (bool ok,) = h.release(r);
        assertTrue(ok, "exactly backed release on the bootstrap path");
        r.coverageAfter.d0Q = 1;
        (bool ok2, RejectCode why) = h.release(r);
        assertFalse(ok2, "leveraged account cannot release using a missing mark");
        assertEq(uint8(why), uint8(RejectCode.INVALID_PRICE_OR_SIZE));
        r.coverageAfter = OA.CoverageInput(0, 0, 2000e24, false);
        (ok,) = h.release(r);
        assertFalse(ok, "market coverage");
        assertEq(uint8(h.pricingMode()), uint8(PricingMode.BOOTSTRAP));
    }

    function test_cutoffPort() public {
        h.init(l, RiskFixture.profile(5, true));
        vm.warp(5000);
        (uint64 accrual, uint64 funding) = h.cutoffs(4000, 0, 0);
        assertEq(accrual, 4000, "accrual stops at epoch end");
        assertEq(funding, 0, "no fresh index: continuous freshness endpoint is 0 until B021");
    }
}
