// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {CombinedBase} from "../../integration/CombinedBase.sol";
import {ReserveVault} from "../../../src/vaults/ReserveVault.sol";
import {MathTypes} from "../../../src/math/MathTypes.sol";
import {RiskLiquidation} from "../../../src/risk/RiskLiquidation.sol";

/// @notice Gas of every combined-engine entry point on the local EVM (forge, evm_version prague:
///         Ethereum gas schedule). Values are call gas measured with gasleft() around one external
///         call from the test contract; they exclude the 21,000 transaction base and calldata cost.
///         Not a Monad measurement. Output lines "gas <name> <value>" are collected into
///         artifacts/risk/gas-engine.json.
contract EngineGasTest is CombinedBase {
    MathTypes.Side constant BUY = MathTypes.Side.BUY;
    MathTypes.Side constant SELL = MathTypes.Side.SELL;
    uint64 lastFeed;

    function _g(string memory name, uint256 used) internal {
        emit log(string.concat("gas ", name, " ", vm.toString(used)));
    }

    function _feed(uint64 to, uint256 idx) internal {
        uint64 from = to - 990 > lastFeed + 10 ? to - 990 : lastFeed + 10;
        vm.warp(to);
        e.feed(from, to, idx, idx - 1e16, idx + 1e16);
        lastFeed = to - ((to - from) % 10);
    }

    /// 64 traders: 1..32 longs (120 USDC, 5x), 33..64 fully backed shorts; normal pricing.
    function _market() internal {
        _deploy(5, 1_000_000);
        uint256[] memory u = new uint256[](64);
        for (uint256 i; i < 64; ++i) u[i] = i < 32 ? 120 : 400;
        _traders(u);
        ReserveVault rv = e.reserveVault();
        vm.prank(LP);
        rv.notice();
        _activate();
        lastFeed = L0 - 1000;
        _feed(L0 + 12 hours, 6e17);
        _roll(32);
        for (uint32 i = 1; i <= 32; ++i) {
            e.rest(32 + i, SELL, 600, 1_000_000);
            e.place(_ioc(i, BUY, 600, 1_000_000));
        }
    }

    function test_gasTradingAndCustody() public {
        _market();
        _fund(_who(65), 1000e6, false); // first allocation registers the account
        token.mint(_who(65), 100e6);
        vm.startPrank(_who(65));
        token.approve(address(vault), 100e6);
        vault.deposit(100e6);
        vm.stopPrank();
        uint256 g = gasleft();
        vm.prank(_who(65));
        vault.allocate(address(e), 100e6, false);
        _g("allocate_existing_account", g - gasleft());
        g = gasleft();
        e.rest(65, BUY, 590, 1000);
        _g("rest_order", g - gasleft());
        g = gasleft();
        e.cancelAll(65);
        _g("cancel_all", g - gasleft());
        for (uint256 k; k < 4; ++k) e.rest(65, SELL, uint16(601 + k), 100);
        g = gasleft();
        e.place(_ioc(64, BUY, 601, 100));
        _g("taker_ioc_1_fill", g - gasleft());
        g = gasleft();
        e.place(_ioc(64, BUY, 604, 300));
        _g("taker_ioc_3_fills_3_makers_levels", g - gasleft());
        g = gasleft();
        vm.prank(_who(65));
        e.release(10e6);
        _g("guarded_release", g - gasleft());
        g = gasleft();
        e.feed(lastFeed + 10, lastFeed + 10, 6e17, 59e16, 61e16);
        _g("price_observation_index_and_perp", g - gasleft());
    }

    function test_gasRolloverPages() public {
        _market();
        vm.warp(_epochEnd());
        uint256 g = gasleft();
        e.beginRollover();
        _g("rollover_begin", g - gasleft());
        uint256 worst;
        while (true) {
            g = gasleft();
            bool done = e.rollPage(32);
            uint256 used = g - gasleft();
            if (used > worst) worst = used;
            if (done) break;
        }
        _g("rollover_page_32_accounts_worst", worst);
        _feed(uint64(block.timestamp), 6e17);
        g = gasleft();
        e.finishRollover();
        _g("rollover_finish_open_epoch", g - gasleft());
    }

    function test_gasLiquidation() public {
        _market();
        uint256 p = 6e17;
        while (p > 52e16) {
            p -= 4e16;
            _feed(uint64(block.timestamp) + 20 minutes, p);
            if (block.timestamp >= _epochEnd()) _roll(32);
        }
        _feed(uint64(block.timestamp) + 20 minutes, p);
        if (block.timestamp >= _epochEnd()) _roll(32);
        _fund(_who(65), 2000e6, false);
        e.rest(65, BUY, 515, 3_000_000);
        uint256 g = gasleft();
        vm.prank(KEEPER);
        e.liquidate(1, 10, 4, 0);
        _g("liquidate_book_close_needs_more_work", g - gasleft());
        g = gasleft();
        vm.prank(KEEPER);
        e.liquidate(2, 1_000_000, 64, 0);
        _g("liquidate_book_close_full_budget", g - gasleft());
        g = gasleft();
        vm.prank(KEEPER);
        e.liquidate(40, 10, 4, 0);
        _g("liquidate_zero_effect_healthy", g - gasleft());
        while (p > 46e16) {
            p -= 3e16;
            _feed(uint64(block.timestamp) + 20 minutes, p);
            if (block.timestamp >= _epochEnd()) _roll(32);
        }
        g = gasleft();
        vm.prank(KEEPER);
        e.liquidate(3, 1, 1, 0);
        _g("liquidate_takeover", g - gasleft());
        g = gasleft();
        vm.prank(KEEPER);
        e.withdrawKeeper();
        _g("keeper_withdraw", g - gasleft());
    }

    function test_gasFloorSweep() public {
        _market();
        _feed(T - 12 hours + 30, 6e17);
        if (block.timestamp >= _epochEnd()) _roll(32);
        uint256 worst;
        while (true) {
            uint256 g = gasleft();
            bool done = uint8(e.floorSweep(32)) == 2; // RECONCILED
            uint256 used = g - gasleft();
            if (used > worst) worst = used;
            if (done) break;
        }
        _g("floor_sweep_page_32_accounts_worst", worst);
    }

    function test_gasHaltPreparationClaims() public {
        _market();
        vm.warp(block.timestamp + 60);
        uint256 g = gasleft();
        oracle.haltEarly();
        _g("halt_early_constant_work", g - gasleft());
        g = gasleft();
        oracle.finalize(1); // YES
        _g("finality_accept_constant_work", g - gasleft());
        uint256 worst;
        while (true) {
            g = gasleft();
            bool done = e.prepareSnapshotChunk(32).done;
            uint256 used = g - gasleft();
            if (used > worst) worst = used;
            if (done) break;
        }
        _g("snapshot_page_32_accounts_worst", worst);
        worst = 0;
        while (true) {
            g = gasleft();
            bool done = e.preparePayoutChunk(32).done;
            uint256 used = g - gasleft();
            if (used > worst) worst = used;
            if (done) break;
        }
        _g("payout_page_32_accounts_worst", worst);
        g = gasleft();
        e.finishPreparation();
        _g("finish_preparation_reserve_pages", g - gasleft());
        g = gasleft();
        e.claimTrader(_who(1));
        _g("trader_claim", g - gasleft());
        vm.warp(block.timestamp + 7 days);
        g = gasleft();
        e.redeemReserve(LP);
        _g("reserve_redeem", g - gasleft());
    }

    function test_gasInvalidCapture() public {
        _market();
        vm.warp(block.timestamp + 60);
        oracle.haltEarly();
        oracle.finalize(3);
        e.feedIndex(T - 86_400 - 20, T + 300, 20, 55e16, 0, 0);
        vm.warp(T);
        uint256 g = gasleft();
        e.captureInvalidPrice();
        _g("invalid_capture_twap", g - gasleft());
    }
}
