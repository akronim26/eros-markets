// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test, console2} from "forge-std/Test.sol";
import {FullEngine} from "../../integration/B/FullLifecycle.t.sol";
import {RiskLiquidation} from "../../../src/risk/RiskLiquidation.sol";
import {IBookRiskHooks} from "../../../src/interfaces/IBookRiskHooks.sol";
import {IMarketConfig} from "../../../src/interfaces/IMarketConfig.sol";
import {IAccountingPort} from "../../../src/interfaces/IAccountingPort.sol";
import {MockBookAdapter} from "../../mocks/B/MockBookAdapter.sol";
import {MockResolutionAuthority} from "../../mocks/B/MockResolutionAuthority.sol";
import {FormulaCoverage} from "../../harness/B/RiskHarness.sol";
import {MathTypes} from "../../../src/math/MathTypes.sol";
import {ListingFixture} from "../../risk/B/B019.t.sol";
import {RiskFixture} from "../../math/B/B011.t.sol";

/// B041: gas of B adapters at configured bounds (local EVM, forge 1.3.5, solc 0.8.30, optimizer
/// 200). Numbers include the mock book's linear scan and the scripted accounting double, so they
/// are regression markers for B code paths, not Monad network costs (see contracts/README.md).
/// Each measurement prints `GAS <name> <value>`; artifacts/risk/gas-adapters.json is built from
/// those lines.
contract AdapterGasTest is Test {
    uint256 constant USDC = 1e24;
    uint64 constant L0 = 1_000_000;
    uint64 T;
    FullEngine e;
    MockResolutionAuthority oracle;

    function setUp() public {
        vm.warp(L0);
        oracle = new MockResolutionAuthority();
        e = new FullEngine();
        IMarketConfig.Listing memory l =
            ListingFixture.make(L0, address(oracle), address(0x30), address(0x60), address(0x51));
        l.scheduledT = L0 + 29 days + 12 hours;
        T = l.scheduledT;
        e.init(l, RiskFixture.profile(5, true));
        oracle.bind(e);
        e.mockSetCoverageScript(new FormulaCoverage(100_000 * USDC, 2_000 * USDC));
        vm.warp(L0 + 12 hours);
        e.feed(L0 + 12 hours - 1000, L0 + 12 hours, 6e17, 59e16, 61e16);
        e.openEpoch();
        e.mockScriptFreeze(IAccountingPort.FreezeResult(0, 0, 1, 0, 1, 0, bytes32(0), bytes32(0)));
    }

    function report(string memory name, uint256 v) internal pure {
        console2.log(string.concat("GAS ", name), v);
    }

    function test_observationUpdateConstantWithFullRing() public {
        uint64 t = L0 + 12 hours + 1;
        vm.warp(t + 3000);
        uint256 g0 = gasleft();
        e.feed(t, t, 6e17, 59e16, 61e16);
        uint256 fresh = g0 - gasleft();
        for (uint64 s = t + 1; s < t + 1100; ++s) {
            e.feed(s, s, 6e17, 59e16, 61e16);
        }
        g0 = gasleft();
        e.feed(t + 1100, t + 1100, 6e17, 59e16, 61e16);
        uint256 full = g0 - gasleft();
        report("observation_index_plus_perp_update_ring_partial", fresh);
        report("observation_index_plus_perp_update_ring_full", full);
        assertLt(full, fresh * 2, "no growth with history: bounded ring + O(log) queries");
    }

    function test_dirtyBook64Examined() public {
        vm.roll(10);
        for (uint32 i; i < 70; ++i) {
            e.mockSetAccount(100 + i, int256(1000 * USDC), 0);
            e.rest(100 + i, MathTypes.Side.SELL, 600, 1);
        }
        vm.roll(11);
        // make every node dirty: owners cancel-all (stale epoch) for half, the rest are self
        for (uint32 i; i < 35; ++i) {
            e.cancelAll(100 + i);
        }
        e.mockSetAccount(1, int256(1000 * USDC), 0);
        IBookRiskHooks.OrderRequest memory r = IBookRiskHooks.OrderRequest(
            1, MathTypes.Side.BUY, IBookRiskHooks.OrderKind.IOC, 600, 100, 0, false, 64
        );
        uint256 g0 = gasleft();
        MockBookAdapter.PlaceResult memory res = e.place(r);
        uint256 used = g0 - gasleft();
        report("taker_64_examined_35_stale_29_filled_mockscan", used);
        assertEq(e.lastExamined(), 64, "stale nodes count against the work limit");
        assertEq(res.filledLots, 29);
    }

    function test_liquidationContinuation() public {
        e.mockSetAccount(1, -int256(540 * USDC), 1_000_000);
        e.mockSetAccount(9, int256(100_000 * USDC), 0);
        e.rest(9, MathTypes.Side.BUY, 600, 2_000_000);
        uint256 g0 = gasleft();
        RiskLiquidation.LiquidationResult memory r = e.liq(1, 1, 8);
        report("liquidate_one_lot_continuation", g0 - gasleft());
        g0 = gasleft();
        r = e.liq(1, 2_000_000, 8);
        report("liquidate_full_restore", g0 - gasleft());
        assertEq(r.lotsAfter > 0, true);
    }

    function test_oracleCallbackIndependentOfParticipants() public {
        vm.warp(L0 + 2 days);
        oracle.haltEarly();
        uint256 g0 = gasleft();
        oracle.finalize(1);
        uint256 few = g0 - gasleft();

        FullEngine e2 = new FullEngine();
        MockResolutionAuthority o2 = new MockResolutionAuthority();
        IMarketConfig.Listing memory l =
            ListingFixture.make(L0, address(o2), address(0x30), address(0x60), address(0x51));
        l.scheduledT = T;
        vm.warp(L0);
        e2.init(l, RiskFixture.profile(5, true));
        o2.bind(e2);
        e2.mockScriptFreeze(IAccountingPort.FreezeResult(0, 0, 1, 0, 1, 0, bytes32(0), bytes32(0)));
        for (uint32 i = 1; i <= 1000; ++i) {
            e2.mockSetAccount(i, 1, 0);
        }
        vm.warp(L0 + 2 days);
        o2.haltEarly();
        g0 = gasleft();
        o2.finalize(1);
        uint256 many = g0 - gasleft();
        report("settle_callback_few_accounts", few);
        report("settle_callback_1000_accounts", many);
        // 1,000x the accounts; the only difference is storage warmth between two deployments.
        uint256 diff = few > many ? few - many : many - few;
        assertLe(diff * 100, few, "callback independent of participant count (within 1%)");
    }

    function test_settlementControllerChunk() public {
        for (uint32 i = 1; i <= 64; ++i) {
            e.mockSetAccount(i, 1, 0);
        }
        vm.warp(L0 + 2 days);
        oracle.finalize(2);
        uint256 g0 = gasleft();
        e.prepareSnapshotChunk(32);
        report("prepare_snapshot_chunk_32_scripted_A", g0 - gasleft());
        e.prepareSnapshotChunk(32);
        g0 = gasleft();
        e.preparePayoutChunk(32);
        report("prepare_payout_chunk_32_scripted_A", g0 - gasleft());
    }
}
