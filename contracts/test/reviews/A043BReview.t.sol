pragma solidity ^0.8.30;

import {CombinedBase} from "../integration/CombinedBase.sol";
import {MathTypes} from "../../src/math/MathTypes.sol";
import {IBookRiskHooks} from "../../src/interfaces/IBookRiskHooks.sol";
import {TradePreview} from "../../src/risk/TradePreview.sol";
import {CombinedEngine} from "../integration/CombinedEngine.sol";
import {CollateralVault} from "../../src/vaults/CollateralVault.sol";
import {IMarketConfig} from "../../src/interfaces/IMarketConfig.sol";
import {MarginMath} from "../../src/math/MarginMath.sol";
import {ListingFixture} from "../risk/B/B019.t.sol";
import {RiskFixture} from "../math/B/B011.t.sol";
import {MockUSDC} from "../mocks/A/MockUSDC.sol";
import {MockResolutionAuthority} from "../mocks/B/MockResolutionAuthority.sol";
import {Vm} from "forge-std/Vm.sol";

contract PartialFeeAllowanceEngine is CombinedEngine {
    constructor(CollateralVault vault, address treasury, IMarketConfig.Listing memory listing)
        CombinedEngine(vault, treasury, listing, RiskFixture.profile(5, true), 1e18)
    {}

    function _forcedFillFee(TakerPermit memory permit, OrderView memory maker, uint64 lots)
        internal
        view
        override
        returns (bool allowed, uint256 feeQ)
    {
        (allowed, feeQ) = super._forcedFillFee(permit, maker, lots);
        feeQ /= 2;
    }
}

contract A043BReviewTest is CombinedBase {
    function _normal(uint256 buyerCash, uint256 sellerCash) internal {
        _normal(buyerCash, sellerCash, 1_000_000);
    }

    function _normal(uint256 buyerCash, uint256 sellerCash, uint64 lots) internal {
        _deploy(5, 100_000);
        uint256[] memory balances = new uint256[](3);
        balances[0] = buyerCash;
        balances[1] = sellerCash;
        balances[2] = 400;
        _traders(balances);
        _activate();
        _keep(L0 + 12 hours, 6e17, true);
        _roll(32);
        e.rest(2, MathTypes.Side.SELL, 600, lots);
        assertEq(e.place(_ioc(1, MathTypes.Side.BUY, 600, lots)).filledLots, lots);
    }

    function testVoluntaryReductionCannotDestroyPositiveEquity() public {
        _normal(120, 400);
        e.rest(3, MathTypes.Side.BUY, 1, 500_000);
        IBookRiskHooks.OrderRequest memory request = _ioc(1, MathTypes.Side.SELL, 1, 500_000);
        request.reduceOnly = true;
        assertEq(e.place(request).filledLots, 0);
        assertEq(_lots(1), 1_000_000);
        assertEq(_cash(1), -int256(480 * USDC));
    }

    function testVoluntaryReductionAtMarkRemainsAllowed() public {
        _normal(120, 400);
        e.rest(3, MathTypes.Side.BUY, 600, 500_000);
        IBookRiskHooks.OrderRequest memory request = _ioc(1, MathTypes.Side.SELL, 600, 500_000);
        request.reduceOnly = true;
        assertEq(e.place(request).filledLots, 500_000);
        _assertInvariants();
    }

    function testUnsafeReduceOnlyMakerIsPruned() public {
        _normal(120, 400);
        IBookRiskHooks.OrderRequest memory request = _ioc(1, MathTypes.Side.SELL, 1, 500_000);
        request.reduceOnly = true;
        request.kind = IBookRiskHooks.OrderKind.POST_ONLY;
        uint32 slot = e.place(request).restedSlot;
        assertGt(slot, 0);
        assertEq(e.place(_ioc(3, MathTypes.Side.BUY, 1, 500_000)).filledLots, 0);
        (, bool live) = e.mockOrder(slot);
        assertFalse(live);
        assertEq(_lots(1), 1_000_000);
    }

    function testReleasePreviewIncludesUntouchedPremium() public {
        _normal(600, 100);
        uint64 cutoff = uint64(block.timestamp) + 600;
        e.feed(uint64(block.timestamp) + 10, cutoff, 6e17, 59e16, 61e16);
        vm.warp(cutoff);
        TradePreview.AccountPreview memory beforeTouch = e.previewAccount(2);
        assertGt(beforeTouch.projectedPremiumQ, 0);
        e.cancelAll(2);
        TradePreview.AccountPreview memory afterTouch = e.previewAccount(2);
        assertEq(beforeTouch.usableReleaseAtoms, afterTouch.usableReleaseAtoms);
        assertEq(beforeTouch.markEquityQ, afterTouch.markEquityQ);
    }

    function testNegativeCashLongCanPreviewPermittedRelease() public {
        _normal(130, 400);
        (bool allowed,) = e.previewRelease(1, 1e6);
        assertTrue(allowed);
        assertGe(e.previewAccount(1).usableReleaseAtoms, 1e6);
    }

    function testAccruedDeficitAboveCapCanStillReduce() public {
        _normal(1000, 2000, 5_000_000);
        uint64 cutoff = uint64(block.timestamp) + 600;
        e.feed(uint64(block.timestamp) + 10, cutoff, 6e17, 59e16, 61e16);
        vm.warp(cutoff);
        e.cancelAll(1);
        assertLt(_cash(1), -int256(2000 * USDC));
        e.rest(3, MathTypes.Side.BUY, 600, 1);
        IBookRiskHooks.OrderRequest memory request = _ioc(1, MathTypes.Side.SELL, 600, 1);
        request.reduceOnly = true;
        assertEq(e.place(request).filledLots, 1);
        _assertInvariants();
    }

    function testForcedFillEventReportsActualWaivedFee() public {
        vm.warp(L0);
        token = new MockUSDC();
        vault = new CollateralVault(address(token), address(this));
        oracle = new MockResolutionAuthority();
        IMarketConfig.Listing memory marketListing =
            ListingFixture.make(L0, address(oracle), MONITOR, GOV, SIGNER);
        marketListing.scheduledT = L0 + 29 days + 12 hours;
        marketListing.token = address(token);
        marketListing.deploymentCapX = 5;
        T = marketListing.scheduledT;
        e = new PartialFeeAllowanceEngine(vault, TREASURY, marketListing);
        vault.registerEngine(address(e));
        oracle.bind(e);
        _fund(LP, 100_000e6, true);
        uint256[] memory balances = new uint256[](3);
        balances[0] = 120;
        balances[1] = 400;
        balances[2] = 400;
        _traders(balances);
        _activate();
        _keep(L0 + 12 hours, 6e17, true);
        _roll(32);
        e.rest(2, MathTypes.Side.SELL, 600, 1_000_000);
        assertEq(e.place(_ioc(1, MathTypes.Side.BUY, 600, 1_000_000)).filledLots, 1_000_000);
        _keep(uint64(block.timestamp) + 20 minutes, 52e16, true);
        if (block.timestamp >= _epochEnd()) _roll(32);
        e.rest(3, MathTypes.Side.BUY, 510, 1_000_000);
        vm.recordLogs();
        vm.prank(KEEPER);
        assertEq(e.liquidate(1, 10, 8, 0).bookLots, 10);
        Vm.Log[] memory records = vm.getRecordedLogs();
        bool found;
        for (uint256 index; index < records.length; ++index) {
            if (
                records[index].emitter != address(e) || records[index].topics.length == 0
                    || records[index].topics[0]
                        != keccak256("Fill(uint32,uint32,uint32,uint24,uint8,uint16,uint64,uint256,uint256)")
            ) continue;
            (,,,,,, uint256 reportedFee) = abi.decode(
                records[index].data, (uint32, uint24, MathTypes.Side, uint16, uint64, uint256, uint256)
            );
            assertEq(reportedFee, 0);
            found = true;
        }
        assertTrue(found);
        assertEq(e.keeperQ(KEEPER), 0);
        _assertInvariants();
    }
}
