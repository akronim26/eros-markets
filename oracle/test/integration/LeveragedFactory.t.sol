pragma solidity ^0.8.30;

import {Book} from "@eros/Book.sol";
import {BookRiskEngine} from "@eros/engine/BookRiskEngine.sol";
import {IMarketConfig} from "@eros/interfaces/IMarketConfig.sol";
import {IBookRiskHooks} from "@eros/interfaces/IBookRiskHooks.sol";
import {IPriceSource} from "@eros/interfaces/IPriceSource.sol";
import {MarginMath} from "@eros/math/MarginMath.sol";
import {RiskLiquidation} from "@eros/risk/RiskLiquidation.sol";
import {RiskContextPort} from "@eros/risk/RiskContextPort.sol";
import {LiquidationMath} from "@eros/math/LiquidationMath.sol";
import {RiskFixture} from "@eros-test/math/B/B011.t.sol";
import {MarketInput, Globals, Ledger, Outcome} from "../../src/types/OracleTypes.sol";
import {RealMarketFixture} from "./RealMarketFixture.sol";

/// Actual registry -> code store -> constructor -> book/risk/vault composition.
/// Prices, collateral and calibration are controlled fixtures, never production calibration.
contract LeveragedFactoryTest is RealMarketFixture {
    BookRiskEngine internal engine;
    address internal capital = makeAddr("leverage-capital");
    address internal bidMaker = makeAddr("backed-bid-maker");
    address internal askMaker = makeAddr("backed-ask-maker");
    uint64 internal sequence;
    uint32 internal bid;
    uint32 internal ask;
    uint256 internal listingDepthLots = 500;
    uint256 internal listingOiCapLots = 10_000_000;

    function _deploy(uint256 cap, uint64 pacing) internal {
        Globals memory globals = _globals();
        globals.maxVoidSecs = 30 days;
        vm.startPrank(gov);
        registry.setGlobals(globals);
        bondTreasury.setLimits(10_000e6, 20);
        vm.stopPrank();
        token.mint(address(this), 500_000e6);
        bondTreasury.deposit(Ledger.ASSERTION, 500_000e6);
        MarketInput memory market = _input(keccak256("reserve-backed-leverage"), false);
        market.tau = NOW + 29 days + 12 hours;
        market.windowEnd = market.tau;
        market.voidSecs = 30 days;
        market.oiCapLots = listingOiCapLots;
        IMarketConfig.Listing memory configuration = _listing();
        configuration.depthNLots = listingDepthLots;
        configuration.deploymentCapX = cap;
        configuration.maxLiqLotsPerBlock = pacing;
        vm.prank(lister);
        engine = BookRiskEngine(registry.createMarket(market, configuration, ""));
    }

    function _allocate(address owner, uint256 atoms, bool reserve) internal {
        token.mint(owner, atoms);
        vm.startPrank(owner);
        token.approve(address(vault), atoms);
        vault.deposit(atoms);
        vault.allocate(address(engine), atoms, reserve);
        vm.stopPrank();
    }

    function _profile() internal pure returns (MarginMath.RiskParams memory p) {
        p = RiskFixture.profile(5, true);
        p.realized.hSecs[0] = 30 days;
        p.templateEnv.hSecs[0] = 30 days;
        p.realized.validFrom = NOW;
        p.templateEnv.validFrom = NOW;
        p.realized.validUntil = NOW + 30 days;
        p.templateEnv.validUntil = NOW + 30 days;
    }

    function testFactoryAcceptsExplicitPacedLeverageWithSafeDefaults() public {
        _deploy(5, 1_000_000);
        assertEq(engine.listing().deploymentCapX, 5);
        assertEq(engine.listing().maxLiqLotsPerBlock, 1_000_000);
        assertFalse(engine.fundingFeatureEnabled());
        assertFalse(engine.recoveryEnabled());
        assertEq(engine.conversionEligibility(), engine.R_DISABLED());
        assertEq(engine.listingHash(), keccak256(abi.encode(engine.listing())));
        assertTrue(vault.engines(address(engine)));
    }

    function testLeveragedActivationRequiresReserveBeforeSeedIsFrozen() public {
        _deploy(5, 1_000_000);
        vm.prank(gov);
        vm.expectRevert();
        engine.activateMarket();
        assertFalse(engine.active());
        _allocate(capital, 100_000e6, true);
        vm.prank(gov);
        engine.activateMarket();
        assertEq(engine.reserveCapBaseQ(), 100_000e24);
        _allocate(capital, 100_000e6, true);
        assertEq(engine.reserveCapBaseQ(), 100_000e24, "donations do not enlarge concentration cap");
        assertEq(engine.reserveVault().totalShares(), 100_000e6);
    }

    function testCalibratedProfileRejectsZeroCloseoutSpeed() public {
        _deploy(5, 1_000_000);
        MarginMath.RiskParams memory p = _profile();
        p.absorptionClaimsPerMin = 0;
        vm.prank(gov);
        vm.expectRevert();
        engine.stageRiskParams(p);
    }

    function testCalibrationRejectsMalformedAndUnboundedEnvelopes() public {
        _deploy(5, 100_000);
        for (uint256 i; i < 7; ++i) {
            MarginMath.RiskParams memory p = _profile();
            if (i == 0) p.realized.hSecs = new uint64[](0);
            if (i == 1) p.realized.hSecs[0] = 0;
            if (i == 2) p.templateEnv.sigmaWad[0] = 1e18 + 1;
            if (i == 3) p.realized.validUntil = p.realized.validFrom;
            if (i == 4) p.epsilonWad = 1e18;
            if (i == 5) p.gammaWad = 1e18 - 1;
            if (i == 6) p.h0Secs = uint256(type(uint64).max) + 1;
            vm.prank(gov);
            vm.expectRevert(BookRiskEngine.InvalidCalibratedProfile.selector);
            engine.stageRiskParams(p);
        }
    }

    function testInitialReserveLimitsAdmissionEvenWithFiveXCalibration() public {
        _deploy(5, 100_000);
        _allocate(capital, 1_000e6, true);
        _allocate(buyer, 120e6, false);
        _allocate(seller, 400e6, false);
        _allocate(bidMaker, 10_000e6, false);
        _allocate(askMaker, 10_000e6, false);
        vm.startPrank(gov);
        engine.stageRiskParams(_profile());
        engine.activateMarket();
        vm.stopPrank();
        _observe(6e17);
        for (uint256 i; i < 30; ++i) {
            vm.warp(block.timestamp + 10);
            vm.roll(block.number + 1);
            _observe(6e17);
        }
        _quotes(6e17);
        engine.samplePerp();
        _normal();
        (uint256 cap,) = engine.leverageCaps();
        assertEq(cap, 5);
        uint32 order = _place(buyer, true, 600, 1_000_000, IBookRiskHooks.OrderKind.POST_ONLY);
        assertGt(order, 0);
        uint256 admitted = engine.getOrder(order).size;
        // 2% of the frozen 1000-token seed is 20; cash 120 + that deficit permits <= 233333 lots.
        assertLe(admitted, 233_333);
        vm.prank(buyer);
        engine.cancel(order);
        _allocate(capital, 100_000e6, true);
        order = _place(buyer, true, 600, 1_000_000, IBookRiskHooks.OrderKind.POST_ONLY);
        assertEq(engine.getOrder(order).size, admitted, "donation cannot expand the frozen per-account deficit cap");
        (int256 noSlack, int256 yesSlack) = engine.coverageSlacks();
        assertGe(noSlack, 0);
        assertGe(yesSlack, 0);
    }

    function _observe(uint256 price) internal {
        IPriceSource.Observation memory observation = _observation(engine, ++sequence);
        observation.priceWad = price;
        observation.impactBidWad = price - 1e16;
        observation.impactAskWad = price + 1e16;
        engine.submitObservation(observation, _sign(INDEX_KEY, engine.observationDigest(observation)));
    }

    function _place(address owner, bool buys, uint16 tick, uint64 lots, IBookRiskHooks.OrderKind kind)
        internal
        returns (uint32 id)
    {
        vm.prank(owner);
        id = engine.placeOrder(Book.Place(kind, buys, false, tick, lots, 8, 0));
    }

    function _quotes(uint256 price) internal {
        if (bid != 0) {
            vm.prank(bidMaker);
            engine.cancel(bid);
        }
        if (ask != 0) {
            vm.prank(askMaker);
            engine.cancel(ask);
        }
        bid = _place(bidMaker, true, uint16(price / 1e15 - 10), 2_000_000, IBookRiskHooks.OrderKind.POST_ONLY);
        ask = _place(askMaker, false, uint16(price / 1e15 + 10), 2_000_000, IBookRiskHooks.OrderKind.POST_ONLY);
        assertGt(bid, 0);
        assertGt(ask, 0);
    }

    function _walk(uint64 until, uint256 price) internal {
        while (block.timestamp < until) {
            vm.warp(block.timestamp + 10);
            vm.roll(block.number + 1);
            _observe(price);
            (,, uint64 end,,,,) = engine.epoch();
            if (block.timestamp >= end) {
                engine.beginRollover();
                while (!engine.rollPage(32)) {}
                engine.finishRollover();
                _quotes(price);
            } else {
                engine.samplePerp();
            }
        }
    }

    function _start(bool calibrate) internal {
        _deploy(5, 100_000);
        _allocate(capital, 100_000e6, true);
        _allocate(buyer, 120e6, false);
        _allocate(seller, 400e6, false);
        _allocate(bidMaker, 10_000e6, false);
        _allocate(askMaker, 10_000e6, false);
        if (calibrate) {
            vm.prank(gov);
            engine.stageRiskParams(_profile());
        }
        vm.prank(gov);
        engine.activateMarket();
        _observe(6e17);
        for (uint256 i; i < 30; ++i) {
            vm.warp(block.timestamp + 10);
            vm.roll(block.number + 1);
            _observe(6e17);
        }
        assertTrue(engine.riskContext().indexOk);
        assertFalse(engine.riskContext().markOk);
        _quotes(6e17);
        engine.samplePerp();
    }

    function _normal() internal {
        _walk(NOW + 4_700, 6e17);
        assertTrue(engine.riskContext().markOk, "real INDEX, book, basis and epoch maturity");
        assertEq(engine.riskContext().markWad, 6e17);
    }

    function testDepthRemainsAvailableAfterBootstrapFill() public {
        listingDepthLots = 1_000_000;
        _start(true);
        uint256 required = engine.listing().depthNLots;
        assertEq(registry.getMarketCore(engine.listing().marketId).oiCapLots, 10 * required);
        _place(buyer, true, 610, 10_000, IBookRiskHooks.OrderKind.IOC);
        assertEq(engine.account(buyer).value.lots, 10_000);
        assertGe(engine.bookDepth().bidDepthLots, required);
        assertGe(engine.bookDepth().askDepthLots, required);
        vm.warp(block.timestamp + 10);
        vm.roll(block.number + 1);
        _observe(6e17);
        engine.samplePerp();
        vm.warp(block.timestamp + 10);
        vm.roll(block.number + 1);
        _observe(6e17);
        assertTrue(engine.samplePerp(), "a filled market can still confirm its next depth sample");
    }

    function testCapEqualToDepthStopsSamplingAfterFirstFill() public {
        listingDepthLots = 1_000_000;
        listingOiCapLots = listingDepthLots;
        _start(true);
        assertEq(engine.bookDepth().bidDepthLots, listingDepthLots);
        _place(buyer, true, 610, 10_000, IBookRiskHooks.OrderKind.IOC);
        assertEq(engine.account(buyer).value.lots, 10_000);
        assertEq(engine.bookDepth().bidDepthLots, 0);
        assertEq(engine.bookDepth().askDepthLots, 0);
    }

    function _position() internal {
        assertGt(_place(seller, false, 600, 1_000_000, IBookRiskHooks.OrderKind.LIMIT), 0);
        _place(buyer, true, 600, 1_000_000, IBookRiskHooks.OrderKind.IOC);
        assertEq(engine.account(buyer).value.lots, 1_000_000);
        assertEq(engine.account(buyer).value.cashQ, -480e24);
        assertEq(engine.account(seller).value.cashQ, 1000e24);
        (int256 noSlack, int256 yesSlack) = engine.coverageSlacks();
        assertGe(noSlack, 0);
        assertGe(yesSlack, 0);
    }

    function testRealSamplerBootstrapAndDirectFiveX() public {
        _start(true);
        (uint256 longCap,) = engine.leverageCaps();
        assertEq(longCap, 1, "bootstrap stays fully backed");
        uint32 backed = _place(buyer, true, 600, 1_000_000, IBookRiskHooks.OrderKind.POST_ONLY);
        assertLe(engine.getOrder(backed).size, 200_000, "admission may halve to fully backed size");
        vm.prank(buyer);
        engine.cancel(backed);
        _normal();
        (longCap,) = engine.leverageCaps();
        assertEq(longCap, 5);
        _position();
        assertEq(engine.accountRiskView(engine.participantId(buyer)).imQ, 120e24);
        assertFalse(engine.fundingFeatureEnabled());
    }

    function testUncalibratedProfileStaysFullyBackedAndStagingWaitsForEpoch() public {
        _start(false);
        _normal();
        uint32 backed = _place(buyer, true, 600, 1_000_000, IBookRiskHooks.OrderKind.POST_ONLY);
        assertLe(engine.getOrder(backed).size, 200_000);
        vm.prank(buyer);
        engine.cancel(backed);
        bytes32 original = engine.activeProfile().profileHash;
        vm.prank(buyer);
        vm.expectRevert(RiskContextPort.RiskUnauthorized.selector);
        engine.stageRiskParams(_profile());
        vm.prank(gov);
        engine.stageRiskParams(_profile());
        assertEq(engine.activeProfile().profileHash, original);
        (uint256 cap,) = engine.leverageCaps();
        assertEq(cap, 1);
        _walk(NOW + 8_300, 6e17);
        assertEq(engine.activeProfile().profileHash, engine.profileHashOf(_profile()));
        _position();
    }

    function testExpiredCalibrationFallsBackAndStaleMarkCannotLiquidate() public {
        _start(true);
        _normal();
        _position();
        vm.warp(block.timestamp + 31);
        (uint256 cap,) = engine.leverageCaps();
        assertEq(cap, 1);
        RiskLiquidation.LiquidationResult memory r = engine.liquidate(engine.participantId(buyer), 100_000, 8, 0);
        assertEq(uint8(r.mode), uint8(LiquidationMath.Mode.NONE));
        assertEq(engine.account(buyer).value.lots, 1_000_000);
        MarginMath.RiskParams memory p = _profile();
        p.realized.validUntil = uint64(block.timestamp + 1);
        vm.prank(gov);
        engine.stageRiskParams(p);
        _walk(NOW + 8_400, 6e17);
        assertTrue(engine.riskContext().markOk);
        (cap,) = engine.leverageCaps();
        assertEq(cap, 1, "expired profile cannot authorize leverage");
        assertGt(engine.accountRiskView(engine.participantId(buyer)).imQ, 500e24);
    }

    function testPositiveEquityReductionUsesRealBookAndBlockPacing() public {
        _start(true);
        _normal();
        _position();
        _quotes(5e17);
        _walk(uint64(block.timestamp + 1_300), 5e17);
        assertTrue(engine.riskContext().markOk);
        assertGt(engine.accountRiskView(engine.participantId(buyer)).markEquityQ, 0);
        uint256 beforeGas = gasleft();
        RiskLiquidation.LiquidationResult memory r = engine.liquidate(engine.participantId(buyer), 1_000_000, 8, 0);
        emit log_named_uint("factory real-book liquidation 100000 lots gas", beforeGas - gasleft());
        assertEq(r.bookLots, 100_000);
        assertEq(uint8(r.result), uint8(LiquidationMath.Result.NEEDS_MORE_WORK));
        r = engine.liquidate(engine.participantId(buyer), 1_000_000, 8, 0);
        assertEq(r.bookLots, 0, "same-block pacing exhausted");
        assertEq(engine.account(buyer).value.lots, 900_000);
        vm.roll(block.number + 1);
        r = engine.liquidate(engine.participantId(buyer), 100_000, 8, 0);
        assertEq(r.bookLots, 100_000);
        assertGt(engine.keeperPayableQ(), 0);
    }

    function testNoLiquidityNeverConfiscatesPositiveEquity() public {
        _start(true);
        _normal();
        _position();
        _quotes(5e17);
        _walk(uint64(block.timestamp + 1_300), 5e17);
        vm.prank(bidMaker);
        engine.cancelAll();
        RiskLiquidation.LiquidationResult memory r = engine.liquidate(engine.participantId(buyer), 100_000, 8, 0);
        assertEq(uint8(r.result), uint8(LiquidationMath.Result.NEEDS_MORE_WORK));
        assertEq(engine.account(buyer).value.lots, 1_000_000);
        assertEq(r.bookLots, 0);
    }

    function testNoJumpPaysWinnerFullyAndReserveAbsorbsDeficit() public {
        _start(true);
        _normal();
        _position();
        bytes32 marketId = engine.listing().marketId;
        _enterReview(engine, true);
        _propose(marketId, Outcome.NO);
        _finalize(marketId, true);
        _prepare(engine);
        assertEq(engine.traderAtoms(buyer), 0);
        assertEq(engine.traderAtoms(seller), 1000e6);
        assertEq(engine.reserveResidualQ(), 99_520e24, "reserve pays the 480 collateral deficit");
        assertEq(engine.getSettlementStatus().totalDeficitQ, 480e24, "frontend reports real bad debt");
        assertFalse(engine.recoveryEnabled());
        assertFalse(engine.useRecovery());
        assertFalse(engine.recoveryRequired());
        assertEq(vault.claim(address(engine), seller), 1000e6);
        assertEq(vault.claimAtoms(address(engine), buyer), 0);
        assertEq(token.balanceOf(seller), 1000e6);
        assertEq(vault.recognizedAtoms(), token.balanceOf(address(vault)));
    }

    function testYesJumpPaysLongFullyWithoutLiquidation() public {
        _start(true);
        _normal();
        _position();
        bytes32 marketId = engine.listing().marketId;
        _enterReview(engine, true);
        _propose(marketId, Outcome.YES);
        _finalize(marketId, true);
        _prepare(engine);
        assertEq(engine.traderAtoms(buyer), 520e6);
        assertEq(engine.traderAtoms(seller), 0);
        assertEq(engine.reserveResidualQ(), 100_000e24);
        assertEq(engine.getSettlementStatus().totalDeficitQ, 0);
        assertEq(vault.claim(address(engine), buyer), 520e6);
    }
}
