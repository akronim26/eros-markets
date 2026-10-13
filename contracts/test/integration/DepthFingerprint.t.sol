pragma solidity ^0.8.30;

import {BookRiskEngineFixture} from "./BookRiskEngine.t.sol";
import {Book} from "../../src/Book.sol";
import {BookRiskEngine} from "../../src/engine/BookRiskEngine.sol";
import {IBookRiskHooks} from "../../src/interfaces/IBookRiskHooks.sol";
import {IPriceSource} from "../../src/interfaces/IPriceSource.sol";
import {PricingMode} from "../../src/math/RiskTypes.sol";
import {RiskFixture} from "../math/B/B011.t.sol";
import {TradePreview} from "../../src/risk/TradePreview.sol";

/// PERP capture sealing with a leveraged account resting near the touch. A capture is seals
/// only if the depth fingerprint is unchanged a block later; time-only accrual on an account
/// whose order is not eligible depth must not invalidate otherwise identical depth.
contract DepthFingerprintTest is BookRiskEngineFixture {
    address constant LEVERED = address(0x105);

    function _leveredEngine() internal {
        vm.chainId(10143);
        configuration.deploymentCapX = 5;
        configuration.maxLiqLotsPerBlock = 10_000_000;
        engine = new BookRiskEngine(vault, TREASURY, configuration);
        vault.registerEngine(address(engine));
        token.mint(address(this), 100_000e6);
        token.approve(address(vault), 100_000e6);
        vault.deposit(100_000e6);
        vault.allocate(address(engine), 100_000e6, true);
        vm.startPrank(GOVERNOR);
        engine.stageRiskParams(RiskFixture.profile(5, true));
        engine.activateMarket();
        vm.stopPrank();
        _fund(BUYER);
        _fund(SELLER);
        token.mint(LEVERED, 20e6);
        vm.startPrank(LEVERED);
        token.approve(address(vault), 20e6);
        vault.deposit(20e6);
        vault.allocate(address(engine), 20e6, false);
        vm.stopPrank();
    }

    function _index() internal {
        IPriceSource.Observation memory o =
            _observation(engine.sourceState(configuration.indexSourceId).lastSequence + 1);
        engine.submitObservation(o, _signature(o, SIGNER_KEY));
    }

    function _post(address owner, bool buys, uint16 tick, uint64 lots) internal returns (uint32) {
        vm.prank(owner);
        return
            engine.placeOrder(Book.Place(IBookRiskHooks.OrderKind.POST_ONLY, buys, false, tick, lots, 8, 0));
    }

    /// One INDEX observation and one sample every 10 seconds; counts seals PERP samples.
    function _run(uint256 steps) internal returns (uint256 seals) {
        for (uint256 i; i < steps; ++i) {
            vm.roll(block.number + 1);
            if (engine.samplePerp()) ++seals;
            vm.warp(block.timestamp + 10);
            _index();
        }
    }

    function _normalPricing() internal {
        _index();
        _post(BUYER, true, 490, 100_000);
        _post(SELLER, false, 510, 100_000);
        _run(8);
        engine.activatePricing();
        assertEq(uint8(engine.pricingMode()), uint8(PricingMode.NORMAL_PRICING));
        assertTrue(engine.riskContext().markOk);
    }

    function _openLeveredLong() internal {
        // 20 USDC buying 50,000 lots (50 claims) at 0.51 needs 25.5 USDC fully backed: leveraged.
        vm.prank(LEVERED);
        engine.placeOrder(Book.Place(IBookRiskHooks.OrderKind.IOC, true, false, 510, 50_000, 8, 0));
        TradePreview.AccountPreview memory p = engine.previewAccount(engine.participantId(LEVERED));
        assertEq(p.positionLots, 50_000, "leveraged long opened");
        assertLt(p.e0Q, 0, "the NO endpoint carries a deficit, so premium accrues over time");
    }

    function testLeveragedRestingOrderDoesNotBlockPerpSealing() public {
        _leveredEngine();
        _normalPricing();
        _openLeveredLong();
        // A small leveraged bid at the touch: ineligible depth (not fully backed), but examined.
        uint32 id = _post(LEVERED, true, 491, 1_000);
        assertTrue(id != 0, "leveraged bid rests");
        uint256 seals = _run(12);
        assertGe(seals, 10, "unchanged eligible depth keeps sealing PERP captures");
        assertTrue(engine.perpTwap60(uint64(block.timestamp)).available);
        assertTrue(engine.riskContext().markOk, "MARK stays available");
    }

    function testLeveragedPositionWithoutRestingOrderKeepsSealing() public {
        _leveredEngine();
        _normalPricing();
        _openLeveredLong();
        assertGe(_run(12), 10);
        assertTrue(engine.riskContext().markOk);
    }

    function testEligibilityChangeStillDiscardsTheCapture() public {
        _leveredEngine();
        _normalPricing();
        // A fully backed bid that becomes ineligible when its owner later takes a levered fill.
        uint32 id = _post(LEVERED, true, 491, 1_000);
        assertTrue(id != 0);
        assertGe(_run(3), 2);
        vm.roll(block.number + 1);
        engine.samplePerp(); // capture with the LEVERED bid counted as eligible depth
        _openLeveredLong(); // book revision changes too; the next sample must discard
        vm.warp(block.timestamp + 10);
        _index();
        vm.roll(block.number + 1);
        assertFalse(engine.samplePerp(), "changed book/eligibility is never sealed");
    }
}
