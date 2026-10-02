// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Vm} from "forge-std/Vm.sol";
import {CombinedBase} from "./CombinedBase.sol";
import {ReserveVault} from "../../src/vaults/ReserveVault.sol";
import {CollateralVault} from "../../src/vaults/CollateralVault.sol";
import {RiskStorage} from "../../src/risk/RiskStorage.sol";
import {AccountingEvents} from "../../src/risk/AccountingEvents.sol";
import {RiskLiquidation} from "../../src/risk/RiskLiquidation.sol";
import {SettlementController} from "../../src/settlement/SettlementController.sol";
import {HaltView} from "../../src/interfaces/IResolutionIngress.sol";
import {LiquidationMath as LM} from "../../src/math/LiquidationMath.sol";
import {LifecycleMath} from "../../src/math/LifecycleMath.sol";
import {MathTypes} from "../../src/math/MathTypes.sol";
import {PricingMode, RejectCode} from "../../src/math/RiskTypes.sol";
import {MockBookAdapter} from "../mocks/B/MockBookAdapter.sol";

/// @notice risk_spec §11 "Minimum end-to-end acceptance scenario" on real Person A + Person B
///         modules (CombinedEngine). Counterparts mocked: book (MockBookAdapter), price feed
///         (test-fed samples), oracle (MockResolutionAuthority), token (MockUSDC), factory
///         (constructor fixture). Step numbers refer to the spec list.
contract EndToEndTest is CombinedBase {
    MathTypes.Side constant BUY = MathTypes.Side.BUY;
    MathTypes.Side constant SELL = MathTypes.Side.SELL;
    uint8 constant HALT_EARLY_MID_ROLLOVER = 0;
    uint8 constant HALT_AT_T = 1;
    uint8 constant HALT_EARLY = 2;
    uint32 constant ALICE = 1;
    uint32 constant BOB = 2;
    uint32 constant MAKER = 3;
    uint32 constant TAKER = 4;
    uint32 constant ZED = 5; // inactive zero-position cash holder
    uint32 constant CAROL = 6;
    uint32 constant DAVE = 7;
    uint32 constant EVE = 8;
    uint64 lastFeed;
    bytes32 listingHash;

    // ---------------------------------------------------------------- steps 1-5

    function _steps1to5() internal {
        // 1. Mocks, vault, one market with the fixture manifest; locked reserve seed; config hashes.
        _deploy(5, 100_000);
        listingHash = e.listingHash();
        assertTrue(listingHash != bytes32(0));
        assertEq(e.reserveVault().totalShares(), 100_000e6, "1 share per seeded atom before activation");
        ReserveVault rv = e.reserveVault();
        vm.prank(LP);
        rv.notice();
        // 2. Fund and allocate; bootstrap exactly backed quotes from an empty book on a valid index.
        uint256[] memory u = new uint256[](8);
        (u[0], u[1], u[2], u[3], u[4], u[5], u[6], u[7]) = (120, 100, 400, 1, 50, 130, 800, 130);
        _traders(u);
        _activate();
        lastFeed = L0 - 1000;
        _feed(L0 + 600, 59e16, 0);
        e.rest(MAKER, SELL, 600, 1000);
        assertEq(e.place(_ioc(TAKER, BUY, 600, 1000)).filledLots, 1000, "bootstrap exactly backed fill");
        assertEq(e.place(_ioc(ALICE, BUY, 600, 1_000_000)).filledLots, 0, "no leverage before normal pricing");
        // 3. Valid windows + epoch opening: fixture leverage and funding on; bilateral 5x position.
        _feed(L0 + 12 hours, 59e16, 6e17);
        _roll(32);
        assertEq(uint8(e.riskContext().pricingMode), uint8(PricingMode.NORMAL_PRICING));
        (, uint64 start,,,, int256 rate,) = e.epoch();
        assertGt(rate, 0, "funding authorized at the fixed epoch rate");
        e.rest(BOB, SELL, 600, 1_000_000);
        assertEq(e.place(_ioc(ALICE, BUY, 600, 1_000_000)).filledLots, 1_000_000);
        assertEq(_cash(ALICE), -int256(480 * USDC));
        assertEq(_cash(BOB), int256(700 * USDC));
        // 4. Funding accrues; another paired trade changes OI; premium at different touch times.
        uint256 b0 = e.fundingBudgetQ();
        uint256 oi0 = e.oiAllLots();
        _feed(start + 20, 59e16, 6e17);
        e.rest(DAVE, SELL, 600, 2_000_000);
        assertEq(e.place(_ioc(CAROL, BUY, 600, 1_000_000)).filledLots, 1_000_000);
        assertEq(e.place(_ioc(EVE, BUY, 600, 1_000_000)).filledLots, 1_000_000);
        // Old OI pays until the OI change; the budget authorized at the opening (bootstrap OI)
        // is not enlarged by later OI (spec §5.4), so it may run out and stop funding for the epoch.
        uint256 perSec = oi0 * uint256(rate);
        uint256 dt = b0 / perSec < 20 ? b0 / perSec : 20;
        assertEq(e.fundingBudgetQ(), b0 - perSec * dt);
        (,,,,,, bool stopped) = e.epoch();
        assertEq(stopped, b0 / perSec <= 20 || e.fundingBudgetQ() < e.oiAllLots() * uint256(rate));
        _feed(start + 200, 59e16, 6e17);
        e.cancelAll(CAROL); // Carol touched at +200 and +400, Eve only at +400
        _feed(start + 400, 59e16, 6e17);
        e.cancelAll(CAROL);
        e.cancelAll(EVE);
        assertEq(_cash(CAROL), _cash(EVE), "touch frequency does not change premium/funding");
        _assertInvariants();
        // 5. Stale orders; a risk epoch ends; rollover blocks ledger mutation until all pages finish.
        e.rest(MAKER, SELL, 610, 10);
        e.cancelAll(MAKER); // stale node stays in the book
        e.rest(MAKER, SELL, 611, 10);
        _feed(_epochEnd(), 59e16, 6e17);
        MockBookAdapter.PlaceResult memory r = e.place(_ioc(TAKER, BUY, 611, 5));
        assertEq(uint8(r.rejection), uint8(RejectCode.BAD_STAGE), "ended epoch: no mutation");
        e.beginRollover();
        assertFalse(e.rollPage(1));
        assertEq(e.place(_ioc(TAKER, BUY, 611, 5)).filledLots, 0, "mid-sweep: no mutation");
    }

    function _finishRoll() internal {
        while (!e.rollPage(3)) {}
        e.finishRollover();
        assertEq(e.fundingClearingQ(), 0);
        assertEq(e.fundingCushionQ(), 0);
        // Both resting maker orders belong to the old market epoch: pruned, never filled.
        assertEq(e.place(_ioc(TAKER, BUY, 611, 5)).filledLots, 0);
        _assertInvariants();
    }

    // ---------------------------------------------------------------- steps 7-10

    function _settle(uint8 haltMode, uint8 oracleOutcome, uint8 page, bool reverse, uint256 expectPrice)
        internal
    {
        vm.recordLogs();
        if (haltMode == HALT_EARLY_MID_ROLLOVER) {
            // 7a. Halt before T while the rollover is interrupted (one page done).
            oracle.haltEarly();
        } else {
            _finishRoll();
            if (haltMode == HALT_AT_T) {
                vm.warp(T);
                e.materializeScheduledHalt(); // permissionless scheduled halt at T
                assertEq(e.getHaltSnapshot().economicHaltAt, T);
            } else {
                vm.warp(block.timestamp + 60);
                oracle.haltEarly();
            }
        }
        HaltView memory h = e.getHaltSnapshot();
        assertTrue(h.halted);
        assertTrue(h.economicHaltAt >= h.accrualCutoff);
        // Duplicate and conflicting finality.
        assertTrue(oracle.finalize(oracleOutcome));
        assertFalse(oracle.finalize(oracleOutcome));
        vm.expectRevert();
        oracle.finalize(oracleOutcome == 1 ? 2 : 1);
        // 8. INVALID waits for capture eligibility (complete TWAP or disclosed fallback).
        while (!e.prepareSnapshotChunk(page).done) {}
        if (oracleOutcome == 3) {
            vm.expectRevert(SettlementController.OutcomeOrPricePending.selector);
            e.preparePayoutChunk(page);
            if (expectPrice == 5e17) {
                e.feedIndex(T - 86_400 - 20, T + 300, 20, 55e16, T - 50_000, T - 49_900);
                vm.warp(T + 3600);
            } else {
                e.feedIndex(T - 86_400 - 20, T + 300, 20, expectPrice, 0, 0);
                vm.warp(T);
            }
            (, bool captured) = e.captureInvalidPrice();
            assertTrue(captured);
        }
        // 9. Claims prepared in pages; LP redeems before some trader claims; claim order varies.
        while (!e.preparePayoutChunk(page).done) {}
        assertTrue(e.finishPreparation());
        assertEq(e.settlementPriceWad(), expectPrice);
        if (block.timestamp < 7 days + L0) vm.warp(L0 + 7 days);
        e.redeemReserve(LP);
        vault.claim(address(e), LP);
        uint32[8] memory order = [ZED, ALICE, BOB, CAROL, EVE, DAVE, MAKER, TAKER];
        for (uint256 i; i < 8; ++i) {
            uint32 id = reverse ? order[7 - i] : order[i];
            uint256 want = _expected(_who(id), expectPrice);
            assertEq(e.traderAtoms(_who(id)), want);
            if (want == 0) continue;
            uint256 b = token.balanceOf(_who(id));
            e.claimTrader(_who(id));
            assertEq(token.balanceOf(_who(id)) - b, want);
        }
        assertEq(e.traderAtoms(_who(ZED)), 50e6, "inactive cash holder frozen and paid");
        // 10. Reconstruct custody and the market ledger from views and A's events.
        _reconstruct(vm.getRecordedLogs());
    }

    function _expected(address who, uint256 priceWad) internal view returns (uint256) {
        (int128 lots, int256 cash) = e.frozen(who);
        int256 v = cash + int256(lots) * 1000 * int256(priceWad);
        return v > 0 ? uint256(v) / 1e18 : 0;
    }

    function _reconstruct(Vm.Log[] memory logs) internal view {
        // Custody in Q: recognized == free + market (less its reclassified debit) + fee escrows
        // + claims over every holder here (A-I01).
        uint256 sum = vault.marketAtoms(address(e)) + vault.freeAtoms(LP) + vault.claimAtoms(address(e), LP)
            + vault.claimAtoms(address(e), TREASURY) + vault.freeAtoms(KEEPER) + vault.freeAtoms(TREASURY);
        for (uint32 i = 1; i <= 8; ++i) {
            sum += vault.freeAtoms(_who(i)) + vault.claimAtoms(address(e), _who(i));
        }
        assertEq(
            sum * 1e18 - vault.marketDebitQ(address(e)) + vault.totalFeeEscrowQ(),
            vault.recognizedAtoms() * 1e18,
            "custody reconstructed from vault views"
        );
        assertGe(token.balanceOf(address(vault)), vault.recognizedAtoms());
        // Account ledger: the last AccountBalance event of every trader equals A's account view.
        bytes32 accTopic = AccountingEvents.AccountBalance.selector;
        for (uint32 id = 1; id <= 8; ++id) {
            bytes32 owner = bytes32(uint256(uint160(_who(id))));
            for (uint256 k = logs.length; k > 0; --k) {
                Vm.Log memory lg = logs[k - 1];
                if (lg.emitter == address(e) && lg.topics[0] == accTopic && lg.topics[1] == owner) {
                    (int128 lots, int256 cash,) = abi.decode(lg.data, (int128, int256, int256));
                    assertEq(lots, e.account(_who(id)).value.lots, "lots from events");
                    assertEq(cash, e.account(_who(id)).value.cashQ, "cash from events");
                    break;
                }
            }
        }
        // Market ledger: the last MarketBalance event carries A's keeper and protocol-fee ledgers.
        bytes32 mktTopic = AccountingEvents.MarketBalance.selector;
        for (uint256 k = logs.length; k > 0; --k) {
            if (logs[k - 1].emitter == address(e) && logs[k - 1].topics[0] == mktTopic) {
                (,,,, uint256 keeper,,,,) = abi.decode(
                    logs[k - 1].data,
                    (uint256, int128, int256, uint256, uint256, int256, uint256, uint256, uint256)
                );
                assertEq(keeper, e.keeperPayableQ(), "keeper ledger from events");
                break;
            }
        }
        assertEq(e.outstandingReserveAtoms() * 1e18 + e.treasuryQ(), e.allocationQ());
        assertEq(
            vault.feeEscrowQ(TREASURY) + vault.keeperPoolQ(address(e)) + vault.feeEscrowQ(KEEPER),
            vault.totalFeeEscrowQ(),
            "fee escrows"
        );
    }

    function _feed(uint64 to, uint256 idx, uint256 perpMid) internal {
        uint64 from = to > 990 && to - 990 > lastFeed + 10 ? to - 990 : lastFeed + 10;
        vm.warp(to);
        if (perpMid == 0) e.feed(from, to, idx, 0, 0);
        else e.feed(from, to, idx, perpMid - 1e16, perpMid + 1e16);
        lastFeed = to - ((to - from) % 10);
    }

    // ---------------------------------------------------------------- outcomes

    function test_e2e_NO_haltMidRollover_pages1_reverseClaims() public {
        _steps1to5();
        _settle(HALT_EARLY_MID_ROLLOVER, 2, 1, true, 0);
    }

    function test_e2e_YES_haltAtT_pages32() public {
        _steps1to5();
        _settle(HALT_AT_T, 1, 32, false, 1e18);
    }

    function test_e2e_earlyINVALID_twap_pages7() public {
        _steps1to5();
        _settle(HALT_EARLY, 3, 7, false, 55e16);
    }

    function test_e2e_earlyINVALID_fallback_pages3_reverseClaims() public {
        _steps1to5();
        _settle(HALT_EARLY, 3, 3, true, 5e17);
    }

    // ---------------------------------------------------------------- step 6 (distinct fixtures)

    function test_e2e_step6_shortfallFixtures() public {
        _steps1to5();
        _finishRoll();
        // Price falls in steps below the movement trigger; Alice (5x long) goes below MM.
        uint256 p = 6e17;
        while (p > 52e16) {
            p -= 4e16;
            _feed(uint64(block.timestamp) + 20 minutes, p, p);
            if (block.timestamp >= _epochEnd()) _roll(32);
        }
        _feed(uint64(block.timestamp) + 20 minutes, p, p);
        if (block.timestamp >= _epochEnd()) _roll(32);
        // Liquidity for the closes (rested after the rollovers, which invalidate older orders).
        e.rest(DAVE, BUY, 510, 1_000_000);
        // Zero-effect call: a healthy account (Bob) is not eligible; no reward.
        vm.prank(KEEPER);
        RiskLiquidation.LiquidationResult memory r = e.liquidate(BOB, 10, 4, 0);
        assertEq(uint8(r.mode), uint8(LM.Mode.NONE));
        assertEq(e.keeperQ(KEEPER), 0, "no reward for a no-effect call");
        // Limited-work continuation: tiny budget closes a little and asks for more work.
        vm.prank(KEEPER);
        r = e.liquidate(ALICE, 3, 2, 0);
        assertEq(uint8(r.result), uint8(LM.Result.NEEDS_MORE_WORK));
        assertEq(r.bookLots, 3);
        // Partial safe reduction with a real budget; never a positive-equity takeover.
        vm.prank(KEEPER);
        r = e.liquidate(ALICE, 1_000_000, 64, 0);
        assertTrue(r.result != LM.Result.TAKEOVER_AUTHORIZED);
        assertLt(_lots(ALICE), 1_000_000 - 3);
        // Keeper withdraws whole atoms; the half-atom residual stays a Q liability.
        uint256 kq = e.keeperQ(KEEPER);
        assertGt(kq, 0);
        vm.prank(KEEPER);
        uint256 atoms = e.withdrawKeeper();
        assertEq(atoms, kq / 1e18);
        assertEq(e.keeperQ(KEEPER), kq % 1e18);
        // Authorized takeover in a distinct fixture: Eve (5x long at 0.60) at mark <= 0.47.
        while (p > 46e16) {
            p -= 3e16;
            _feed(uint64(block.timestamp) + 20 minutes, p, p);
            if (block.timestamp >= _epochEnd()) _roll(32);
        }
        assertLe(e.previewAccount(EVE).markEquityQ, 0);
        (int128 rl0,) = e.reserve();
        int256 eveLots = _lots(EVE);
        vm.prank(KEEPER);
        r = e.liquidate(EVE, 1, 1, 0);
        assertEq(uint8(r.result), uint8(LM.Result.TAKEOVER_AUTHORIZED));
        (int128 rl1,) = e.reserve();
        assertEq(int256(rl1) - rl0, eveLots);
        _assertInvariants();
    }
}
