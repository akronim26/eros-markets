// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {CombinedEngine} from "../../integration/CombinedEngine.sol";
import {CollateralVault} from "../../../src/vaults/CollateralVault.sol";
import {ReserveVault} from "../../../src/vaults/ReserveVault.sol";
import {RiskStorage} from "../../../src/risk/RiskStorage.sol";
import {IBookRiskHooks} from "../../../src/interfaces/IBookRiskHooks.sol";
import {IMarketConfig} from "../../../src/interfaces/IMarketConfig.sol";
import {CoverageMath as C} from "../../../src/math/CoverageMath.sol";
import {MathTypes, AccountingState} from "../../../src/math/MathTypes.sol";
import {LifecycleMath} from "../../../src/math/LifecycleMath.sol";
import {RiskLiquidation} from "../../../src/risk/RiskLiquidation.sol";
import {MockUSDC} from "../../mocks/A/MockUSDC.sol";
import {MockResolutionAuthority} from "../../mocks/B/MockResolutionAuthority.sol";
import {ListingFixture} from "../../risk/B/B019.t.sol";
import {RiskFixture} from "../../math/B/B011.t.sol";

/// @notice Random-action driver over the combined A+B engine. Every engine call is wrapped so the
///         campaign can run with fail_on_revert; expected rejections are not failures. Ghost
///         counters record INV-07/INV-08/INV-09 violations observed inside actions.
contract CombinedHandler is Test {
    CombinedEngine public e;
    CollateralVault public vault;
    MockUSDC public token;
    MockResolutionAuthority public oracle;
    uint64 public T;
    uint64 public lastFeed;
    uint256 public price = 6e17;
    uint32 public constant N = 6;
    address constant LP = address(0xCAFE);
    address constant KEEPER = address(0xBEEF);

    // ghosts
    uint256 public step; // actions so far in this run; settlement actions open after TRADE_STEPS
    uint256 public constant TRADE_STEPS = 40;
    uint256 public inv07Violations;
    uint256 public inv08Violations;
    uint256 public claimedAtoms;
    uint256 public claimsBeforeEnable;
    mapping(bytes32 => uint256) public calls;
    mapping(bytes32 => uint256) public done; // effective outcomes (not just attempts)

    constructor(
        CombinedEngine e_,
        CollateralVault v,
        MockUSDC t,
        MockResolutionAuthority o,
        uint64 T_,
        uint64 lf
    ) {
        (e, vault, token, oracle, T, lastFeed) = (e_, v, t, o, T_, lf);
    }

    function who(uint32 id) public pure returns (address) {
        return address(uint160(0x1000 + id));
    }

    function _id(uint256 seed) internal pure returns (uint32) {
        return uint32(seed % N) + 1;
    }

    function _lots() internal view returns (int256[N + 1] memory x) {
        (int128 r,) = e.reserve();
        x[0] = r;
        for (uint32 i = 1; i <= N; ++i) {
            x[i] = e.account(who(i)).value.lots;
        }
    }

    function _positionsUnchanged(int256[N + 1] memory before) internal {
        int256[N + 1] memory after_ = _lots();
        for (uint256 i; i <= N; ++i) {
            if (after_[i] != before[i]) inv08Violations += 1;
        }
    }

    function _fundingCheck(bool stoppedBefore, uint64 idBefore, int256 fBefore) internal {
        (uint64 id,,,,,,) = e.epoch();
        if (stoppedBefore && id == idBefore && e.fundingFQ() != fBefore) inv07Violations += 1;
    }

    function _epochState() internal view returns (bool stopped, uint64 id, int256 f) {
        (id,,,,,, stopped) = e.epoch();
        f = e.fundingFQ();
    }

    // ------------------------------------------------------------------ actions

    function allocate(uint256 seed, uint256 usdc) external {
        calls["allocate"]++;
        step++;
        uint32 id = _id(seed);
        uint256 atoms = bound(usdc, 1, 500) * 1e6;
        int256[N + 1] memory before = _lots();
        token.mint(who(id), atoms);
        vm.startPrank(who(id));
        token.approve(address(vault), atoms);
        vault.deposit(atoms);
        try vault.allocate(address(e), atoms, false) {} catch {}
        vm.stopPrank();
        _positionsUnchanged(before);
    }

    function rest(uint256 seed, bool buy, uint256 tick, uint256 lots) external {
        calls["rest"]++;
        step++;
        uint16 t = uint16(bound(tick, price / 1e15 - 30, price / 1e15 + 30));
        try e.rest(
            _id(seed), buy ? MathTypes.Side.BUY : MathTypes.Side.SELL, t, uint64(bound(lots, 1, 300_000))
        ) {
            done["rest"]++;
        } catch {}
    }

    function place(uint256 seed, bool buy, uint256 tick, uint256 lots) external {
        calls["place"]++;
        step++;
        (bool s, uint64 id, int256 f) = _epochState();
        uint16 t = uint16(bound(tick, price / 1e15 - 30, price / 1e15 + 30));
        IBookRiskHooks.OrderRequest memory r = IBookRiskHooks.OrderRequest(
            _id(seed),
            buy ? MathTypes.Side.BUY : MathTypes.Side.SELL,
            IBookRiskHooks.OrderKind.IOC,
            t,
            uint64(bound(lots, 1, 300_000)),
            0,
            false,
            8
        );
        try e.place(r) returns (CombinedEngine.PlaceResult memory res) {
            if (res.filledLots != 0) {
                done["fill"]++;
                done["filledLots"] += res.filledLots;
            }
        } catch {}
        _fundingCheck(s, id, f);
    }

    /// 5x entry: trader 1 or 3 (120 USDC) buys 1,000 claims from trader 2 or 4 resting at the
    /// current price tick (fully backed short).
    function leverage(uint256 seed) external {
        calls["leverage"]++;
        step++;
        (uint32 longId, uint32 shortId) = seed % 2 == 0 ? (uint32(1), uint32(2)) : (uint32(3), uint32(4));
        uint16 t = uint16(price / 1e15);
        try e.rest(shortId, MathTypes.Side.SELL, t, 1_000_000) {} catch {}
        IBookRiskHooks.OrderRequest memory r = IBookRiskHooks.OrderRequest(
            longId, MathTypes.Side.BUY, IBookRiskHooks.OrderKind.IOC, t, 1_000_000, 0, false, 8
        );
        try e.place(r) returns (CombinedEngine.PlaceResult memory res) {
            if (res.filledLots != 0) done["leverage"]++;
        } catch {}
    }

    /// Price shock: three 0.04 steps 20 minutes apart (each below the 0.10 / 300 s trigger).
    function shock(bool up) external {
        calls["shock"]++;
        step++;
        for (uint256 i; i < 3; ++i) {
            this.advance(20 minutes, 4e16, up);
        }
        this.liquidate(up ? 1 : 0, up ? 1000 : 1_000_000, 7); // keeper reacts to the move
    }

    function place2(uint256 seed, bool buy, uint256 tick, uint256 lots) external {
        this.place(seed, buy, tick, lots);
    }

    function rest2(uint256 seed, bool buy, uint256 tick, uint256 lots) external {
        this.rest(seed, buy, tick, lots);
    }

    function cancelAll(uint256 seed) external {
        calls["cancelAll"]++;
        step++;
        int256[N + 1] memory before = _lots();
        try e.cancelAll(_id(seed)) {} catch {}
        _positionsUnchanged(before);
    }

    function release(uint256 seed, uint256 atoms) external {
        calls["release"]++;
        step++;
        int256[N + 1] memory before = _lots();
        uint32 id = _id(seed);
        vm.prank(who(id));
        try e.release(bound(atoms, 1, 200e6)) {
            done["release"]++;
        } catch {}
        _positionsUnchanged(before);
    }

    /// Advance 15-40 minutes with a bounded price step (below the movement trigger), roll if due.
    function advance(uint256 dt, uint256 stepSize, bool up) external {
        calls["advance"]++;
        step++;
        if (e.halted()) return;
        int256[N + 1] memory before = _lots();
        uint256 d = bound(stepSize, 0, 4e16);
        price = up ? (price + d > 7e17 ? 7e17 : price + d) : (price < 3e17 + d ? 3e17 : price - d);
        uint64 to = uint64(block.timestamp) + uint64(bound(dt, 15 minutes, 40 minutes));
        if (to >= T) return;
        uint64 from = to - 990 > lastFeed + 10 ? to - 990 : lastFeed + 10;
        vm.warp(to);
        e.feedStep(from, to, 25, price, price - 1e16, price + 1e16);
        lastFeed = to - ((to - from) % 25);
        (uint64 id,, uint64 end,,,,) = e.epoch();
        id;
        if (block.timestamp >= end && e.work() == AccountingState.READY) {
            try e.beginRollover() {} catch {}
        }
        if (e.work() == AccountingState.ROLLOVER_SWEEP) {
            for (uint256 i; i < 4; ++i) {
                try e.rollPage(4) returns (bool done) {
                    if (done) break;
                } catch {
                    break;
                }
            }
            try e.finishRollover() {
                done["rollover"]++;
            } catch {}
        }
        _positionsUnchanged(before); // rollover and price feeds never move positions
    }

    function liquidate(uint256 seed, uint256 lots, uint256 partner) external {
        calls["liquidate"]++;
        step++;
        vm.prank(KEEPER);
        (int128 rl,) = e.reserve();
        uint32 target = seed % 3 == 2 ? _id(seed >> 2) : (seed % 2 == 0 ? uint32(1) : uint32(3)); // mostly the 5x accounts
        try e.liquidate(
            target, uint64(bound(lots, 1, 1_000_000)), 8, partner % 3 == 0 ? _id(partner >> 8) : 0
        ) returns (
            RiskLiquidation.LiquidationResult memory r
        ) {
            if (r.pairedLots + r.bookLots != 0) done["liqReduce"]++;
            (int128 rl2,) = e.reserve();
            if (rl2 != rl) done["takeover"]++;
        } catch {}
    }

    /// Rare: jump to the backing floor and sweep it in pages.
    function floor(uint256 page) external {
        calls["floor"]++;
        step++;
        if (e.halted() || block.timestamp >= T - 12 hours || step < 30) return;
        uint64 to = T - 12 hours + 30;
        uint64 from = to - 990;
        vm.warp(to);
        e.feedStep(from, to, 25, price, price - 1e16, price + 1e16);
        lastFeed = to - ((to - from) % 25);
        if (e.work() == AccountingState.READY && block.timestamp >= _end()) {
            try e.beginRollover() {} catch {}
            for (uint256 i; i < 8; ++i) {
                try e.rollPage(32) returns (bool done) {
                    if (done) break;
                } catch {
                    break;
                }
            }
            try e.finishRollover() {} catch {}
        }
        for (uint256 i; i < 8; ++i) {
            try e.floorSweep(bound(page, 1, 32)) {}
            catch {
                break;
            }
        }
        if (e.fullBackingReconciled()) done["floorReconciled"]++;
    }

    function _end() internal view returns (uint64 end) {
        (,, end,,,,) = e.epoch();
    }

    function halt() external {
        calls["halt"]++;
        step++;
        if (e.halted() || step < TRADE_STEPS) return;
        int256[N + 1] memory before = _lots();
        try oracle.haltEarly() {
            done["halt"]++;
        } catch {}
        _positionsUnchanged(before);
    }

    function finalize(uint256 outcome) external {
        calls["finalize"]++;
        step++;
        if (!e.halted()) return;
        int256[N + 1] memory before = _lots();
        try oracle.finalize(uint8(bound(outcome, 1, 3))) returns (bool fresh) {
            if (fresh) done["finality"]++;
        } catch {}
        _positionsUnchanged(before);
    }

    function captureInvalid() external {
        calls["capture"]++;
        step++;
        if (!e.halted() || e.finalOutcome() != MathTypes.FinalOutcome.INVALID) return;
        if (block.timestamp < T + 3600) vm.warp(T + 3600); // no window data: disclosed fallback
        try e.captureInvalidPrice() returns (LifecycleMath.InvalidReadiness, bool c) {
            if (c) done["invalidCaptured"]++;
        } catch {}
    }

    function prepare(uint256 page) external {
        calls["prepare"]++;
        step++;
        if (!e.halted()) return;
        int256[N + 1] memory before = _lots();
        uint256 p = bound(page, 1, 32);
        try e.prepareSnapshotChunk(p) {} catch {}
        try e.preparePayoutChunk(p) {} catch {}
        try e.finishPreparation() returns (bool en) {
            if (en) done["claimsEnabled"]++;
        } catch {}
        _positionsUnchanged(before);
    }

    function claim(uint256 seed) external {
        calls["claim"]++;
        step++;
        address w = who(_id(seed));
        uint256 b = token.balanceOf(w);
        try e.claimTrader(w) {
            if (!e.claimsEnabled()) claimsBeforeEnable += 1;
            claimedAtoms += token.balanceOf(w) - b;
            done["claimPaid"]++;
        } catch {}
    }
}

/// @notice INV-01..INV-10 campaign on real A+B (CombinedEngine). Counterparts mocked.
contract CombinedInvariantsTest is Test {
    CombinedEngine e;
    CollateralVault vault;
    MockUSDC token;
    MockResolutionAuthority oracle;
    CombinedHandler h;
    uint64 constant L0 = 1_000_000;

    function setUp() public {
        vm.warp(L0);
        token = new MockUSDC();
        vault = new CollateralVault(address(token), address(this));
        oracle = new MockResolutionAuthority();
        IMarketConfig.Listing memory l =
            ListingFixture.make(L0, address(oracle), address(0x30), address(0x60), address(0x51));
        l.scheduledT = L0 + 29 days + 12 hours;
        l.token = address(token);
        e = new CombinedEngine(vault, address(0x777), l, RiskFixture.profile(5, true), 1e18);
        vault.registerEngine(address(e));
        oracle.bind(e);
        _fund(address(0xCAFE), 100_000e6, true);
        uint256[6] memory cash = [uint256(120e6), 400e6, 120e6, 400e6, 400e6, 400e6];
        for (uint32 i = 1; i <= 6; ++i) {
            _fund(address(uint160(0x1000 + i)), cash[i - 1], false);
        }
        vm.prank(address(0x60));
        e.activateMarket();
        uint64 to = L0 + 12 hours;
        vm.warp(to);
        e.feed(to - 990, to, 6e17, 59e16, 61e16);
        e.beginRollover();
        while (!e.rollPage(32)) {}
        e.finishRollover();
        h = new CombinedHandler(e, vault, token, oracle, l.scheduledT, to);
        targetContract(address(h));
    }

    function _fund(address w, uint256 atoms, bool reserve_) internal {
        token.mint(w, atoms);
        vm.startPrank(w);
        token.approve(address(vault), atoms);
        vault.deposit(atoms);
        vault.allocate(address(e), atoms, reserve_);
        vm.stopPrank();
    }

    /// INV-01 net position zero (live ledger; frozen snapshot after a halt).
    function invariant_INV01_netPositionZero() public view {
        (int128 rn,) = e.reserve();
        int256 n = rn;
        for (uint256 i; i < e.participantCount(); i++) {
            n += e.account(e.participants(i)).value.lots;
        }
        assertEq(n, 0);
    }

    /// INV-02 virtual cash + fee/payable/clearing ledgers == allocationQ, until payouts start.
    function invariant_INV02_ledgerIdentity() public view {
        if (e.payoutsAllocated() || e.allocationCursor() != 0) {
            // Payout escrow pages move allocation out page by page (spec: preparation
            // accumulators are incomplete until their cursor finishes); check the final identity.
            if (e.claimsEnabled()) {
                assertEq(
                    e.outstandingReserveAtoms() * 1e18 + e.treasuryQ() + e.protocolFeeEscrowQ()
                        + e.keeperPayableQ(),
                    e.allocationQ()
                );
            }
            return;
        }
        (, int256 rc) = e.reserve();
        int256 cash = rc;
        for (uint256 i; i < e.participantCount(); i++) {
            cash += e.account(e.participants(i)).value.cashQ;
        }
        assertEq(
            cash + int256(e.protocolFeeQ() + e.keeperPayableQ()) + e.fundingClearingQ(),
            int256(e.allocationQ())
        );
    }

    /// INV-03 recognized custody <= actual token custody; market allocation in atoms.
    function invariant_INV03_custody() public view {
        assertGe(token.balanceOf(address(vault)), vault.recognizedAtoms());
        assertEq(vault.marketAtoms(address(e)) * 1e18, e.allocationQ());
    }

    /// INV-04 both outcome coverage inequalities (live and frozen).
    function invariant_INV04_coverage() public view {
        if (e.payoutsAllocated()) return; // reserve residual assigned; coverage no longer defined
        (int256 s0, int256 s1) = e.coverageSlacks();
        assertGe(s0, 0);
        assertGe(s1, 0);
    }

    /// INV-05 every stored contribution equals A's order-aware deficits of the account's own
    /// (cash, position, live orders) at its last synchronization; the sums are exact.
    function invariant_INV05_storedContributions() public view {
        uint256 s0;
        uint256 s1;
        for (uint256 i; i < e.participantCount(); i++) {
            RiskStorage.Account memory a = e.account(e.participants(i));
            (uint256 d0, uint256 d1) = C.deficits(a.value, a.orders);
            assertEq(a.deficit0, d0);
            assertEq(a.deficit1, d1);
            s0 += a.deficit0;
            s1 += a.deficit1;
        }
        assertEq(e.deficitSum0(), s0);
        assertEq(e.deficitSum1(), s1);
    }

    /// INV-07 a stopped funding epoch never moves the index again (observed inside actions).
    function invariant_INV07_noCatchUp() public view {
        assertEq(h.inv07Violations(), 0);
    }

    /// INV-08 only fills/takeovers move positions (deposit, release, cancel, prices, rollover,
    /// halt, finality, preparation never do).
    function invariant_INV08_positionsOnlyByFills() public view {
        assertEq(h.inv08Violations(), 0);
    }

    /// INV-09 no claim before claims are enabled; claimed atoms never exceed allocated atoms.
    function invariant_INV09_claims() public view {
        assertEq(h.claimsBeforeEnable(), 0);
        assertLe(h.claimedAtoms(), e.totalTraderAtoms());
    }

    /// INV-10 the frozen snapshot uses one cutoff for every account.
    function invariant_INV10_singleCutoff() public view {
        if (!e.snapshotComplete()) return;
        uint64 cut = e.accrualCutoff();
        for (uint256 i; i < e.participantCount(); i++) {
            assertEq(e.account(e.participants(i)).lastTouchedAt, cut);
        }
    }

    /// Campaign coverage: effective outcomes per run (forge -vv prints them).
    function afterInvariant() external {
        bytes32[13] memory k = [
            bytes32("rest"),
            "fill",
            "filledLots",
            "release",
            "rollover",
            "liqReduce",
            "takeover",
            "floorReconciled",
            "halt",
            "finality",
            "invalidCaptured",
            "claimsEnabled",
            "claimPaid"
        ];
        string memory line = "COVERAGE";
        for (uint256 i; i < k.length; ++i) {
            line = string.concat(line, " ", string(abi.encodePacked(k[i])), "=", vm.toString(h.done(k[i])));
        }
        emit log(line);
    }
}

/// @notice Deterministic seeded campaign over the same handler: every invariant is checked after
///         every action, and effective outcomes are summed over all seeds (reported with -vv).
contract CombinedCampaignTest is CombinedInvariantsTest {
    function _checkAll() internal view {
        invariant_INV01_netPositionZero();
        invariant_INV02_ledgerIdentity();
        invariant_INV03_custody();
        invariant_INV04_coverage();
        invariant_INV05_storedContributions();
        invariant_INV07_noCatchUp();
        invariant_INV08_positionsOnlyByFills();
        invariant_INV09_claims();
        invariant_INV10_singleCutoff();
    }

    function _act(uint256 r) internal {
        uint256 a = r % 19;
        uint256 x = r >> 8;
        if (a <= 2) h.place(x, (x & 1) == 1, x >> 3, x >> 40);
        else if (a <= 4) h.rest(x, (x & 2) == 2, x >> 5, x >> 44);
        else if (a == 5) h.cancelAll(x);
        else if (a == 6) h.allocate(x, x >> 9);
        else if (a == 7) h.release(x, x >> 11);
        else if (a <= 9) h.advance(x, x >> 13, (x & 4) == 4);
        else if (a == 10) h.liquidate(x, x >> 7, x >> 17);
        else if (a == 11) h.floor(x);
        else if (a == 12) h.halt();
        else if (a == 13) h.finalize(x);
        else if (a == 14) h.captureInvalid();
        else if (a == 15) h.prepare(x);
        else if (a == 16) h.claim(x);
        else if (a == 17) h.leverage(x);
        else h.shock((x & 8) == 8);
    }

    function test_seededCampaign_0_2() public {
        _campaign(0, 3);
    }

    function test_seededCampaign_3_5() public {
        _campaign(3, 6);
    }

    function test_seededCampaign_6_8() public {
        _campaign(6, 9);
    }

    function test_seededCampaign_9_11() public {
        _campaign(9, 12);
    }

    function test_seededCampaign_12_14() public {
        _campaign(12, 15);
    }

    function test_seededCampaign_15_17() public {
        _campaign(15, 18);
    }

    function test_seededCampaign_18_20() public {
        _campaign(18, 21);
    }

    function test_seededCampaign_21_23() public {
        _campaign(21, 24);
    }

    function _campaign(uint256 first, uint256 last) internal {
        uint256[13] memory total;
        for (uint256 seed = first; seed < last; ++seed) {
            uint256 snap = vm.snapshotState();
            uint256[13] memory c = this.runSeed(seed); // external: memory resets per seed
            for (uint256 n; n < 13; ++n) {
                total[n] += c[n];
            }
            vm.revertToState(snap);
        }
        bytes32[13] memory k = _keys();
        string memory line = string.concat(
            "CAMPAIGN seeds=", vm.toString(first), "..", vm.toString(last - 1), " steps=64+settlement"
        );
        for (uint256 n; n < k.length; ++n) {
            line = string.concat(line, " ", string(abi.encodePacked(k[n])), "=", vm.toString(total[n]));
        }
        emit log(line);
    }

    function _keys() internal pure returns (bytes32[13] memory) {
        return [
            bytes32("leverage"),
            "fill",
            "filledLots",
            "release",
            "rollover",
            "liqReduce",
            "takeover",
            "floorReconciled",
            "halt",
            "finality",
            "invalidCaptured",
            "claimsEnabled",
            "claimPaid"
        ];
    }

    function stepOnce(uint256 r) external {
        _act(r);
        _checkAll();
    }

    function settleOnce(uint256 seed, uint256 j) external {
        if (j == 0) {
            h.halt();
            for (uint256 x; x < 3; ++x) {
                h.finalize(seed + x);
            }
            h.captureInvalid();
        } else if (j <= 40) {
            h.prepare(seed % 32 + 1);
        } else {
            h.claim(j);
        }
        _checkAll();
    }

    function runSeed(uint256 seed) external returns (uint256[13] memory c) {
        for (uint256 i; i < 64; ++i) {
            this.stepOnce(uint256(keccak256(abi.encode(seed, i))));
        }
        for (uint256 j; j < 53; ++j) {
            this.settleOnce(seed, j);
        }
        bytes32[13] memory k = _keys();
        for (uint256 n; n < 13; ++n) {
            c[n] = h.done(k[n]);
        }
    }
}
