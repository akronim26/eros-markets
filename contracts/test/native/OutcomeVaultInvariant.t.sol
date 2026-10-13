// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {MathTypes} from "../../src/math/MathTypes.sol";
import {RegistryMarketCore} from "../../src/native/INativeMarketReads.sol";
import {NativeOutcomeVault} from "../../src/native/NativeOutcomeVault.sol";
import {OutcomeToken} from "../../src/native/OutcomeToken.sol";
import {MockCollateral, MockEngine, MockRegistry} from "./NativeMocks.sol";

/// @notice Random split / merge / transfer / donate / resolve / fragmented-redeem sequences.
contract OutcomeVaultHandler is Test {
    NativeOutcomeVault public vault;
    MockCollateral public usdc;
    MockEngine public eng;
    OutcomeToken public yes;
    OutcomeToken public no;
    address[3] public actors;

    // Ghost accounting, maintained only from successful actions.
    uint256 public deposited;
    uint256 public merged;
    uint256 public donated;
    uint256 public redeemedPaid;
    uint256 public setsAtResolution;

    constructor(NativeOutcomeVault v, MockCollateral u, MockEngine e) {
        vault = v;
        usdc = u;
        eng = e;
        yes = v.yes();
        no = v.no();
        actors = [makeAddr("a0"), makeAddr("a1"), makeAddr("a2")];
        for (uint256 i; i < 3; ++i) {
            u.mint(actors[i], 1e15);
            vm.prank(actors[i]);
            u.approve(address(v), type(uint256).max);
        }
    }

    function _actor(uint256 s) internal view returns (address) {
        return actors[s % 3];
    }

    /// @dev The k-th actor after `_actor(s)`, without overflowing on large fuzzed seeds.
    function _next(uint256 s, uint256 k) internal view returns (address) {
        return actors[(s % 3 + k) % 3];
    }

    function split(uint256 s, uint256 atoms) external {
        if (!vault.issuanceOpen()) return;
        uint256 room = vault.issuanceCap() - vault.outstandingSets();
        if (room == 0) return;
        atoms = bound(atoms, 1, room < 1e9 ? room : 1e9);
        vm.prank(_actor(s));
        vault.split(atoms, _next(s, 1));
        deposited += atoms;
    }

    function merge(uint256 s, uint256 atoms) external {
        if (vault.resolved()) return;
        address a = _actor(s);
        uint256 maxSets = yes.balanceOf(a) < no.balanceOf(a) ? yes.balanceOf(a) : no.balanceOf(a);
        if (maxSets == 0) return;
        atoms = bound(atoms, 1, maxSets);
        vm.prank(a);
        vault.merge(atoms, _next(s, 2));
        merged += atoms;
    }

    function transfer(uint256 s, uint256 atoms, bool side) external {
        address a = _actor(s);
        OutcomeToken t = side ? yes : no;
        uint256 bal = t.balanceOf(a);
        if (bal == 0) return;
        atoms = bound(atoms, 1, bal);
        vm.prank(a);
        t.transfer(_next(s, 1), atoms);
    }

    function donate(uint256 s, uint256 atoms) external {
        atoms = bound(atoms, 1, 1e8);
        vm.prank(_actor(s));
        usdc.transfer(address(vault), atoms);
        donated += atoms;
    }

    function resolve(uint256 outcome, uint256 price) external {
        if (vault.resolved()) return;
        uint256 o = bound(outcome, 0, 2);
        eng.setHalted(true);
        if (o == 0) eng.setOutcome(MathTypes.FinalOutcome.NO, false, 0);
        else if (o == 1) eng.setOutcome(MathTypes.FinalOutcome.YES, false, 0);
        else eng.setOutcome(MathTypes.FinalOutcome.INVALID, true, bound(price, 0, 1e18));
        vault.syncResolution();
        setsAtResolution = vault.outstandingSets();
    }

    function redeem(uint256 s, uint256 y, uint256 n) external {
        if (!vault.resolved()) return;
        address a = _actor(s);
        y = bound(y, 0, yes.balanceOf(a));
        n = bound(n, 0, no.balanceOf(a));
        if (y == 0 && n == 0) return;
        vm.prank(a);
        redeemedPaid += vault.redeem(y, n, a);
    }
}

/// @notice NM-C08: complete-set conservation across arbitrary action sequences.
contract OutcomeVaultInvariantTest is Test {
    OutcomeVaultHandler internal h;
    NativeOutcomeVault internal vault;
    MockCollateral internal usdc;

    function setUp() public {
        vm.warp(1_800_000_000);
        uint64 t = uint64(block.timestamp + 2 days);
        bytes32 market = keccak256("inv");
        bytes32 rules = keccak256("rules");
        usdc = new MockCollateral(6);
        MockRegistry reg = new MockRegistry();
        MockEngine eng = new MockEngine();
        vault = new NativeOutcomeVault(address(reg), market, address(usdc), rules, t, 1e13, "Y", "N");
        RegistryMarketCore memory c;
        c.engine = address(eng);
        c.tau = t;
        c.rulesHash = rules;
        reg.setCore(market, c);
        eng.setListing(market, address(usdc), address(reg), t, rules, address(0x0A11CE));
        vault.bindMarket();
        h = new OutcomeVaultHandler(vault, usdc, eng);
        targetContract(address(h));
    }

    /// Before resolution: YES supply == NO supply == outstanding sets, and sets <= cap.
    function invariant_supplyEqualsSets() public view {
        if (vault.resolved()) return;
        assertEq(vault.yes().totalSupply(), vault.outstandingSets());
        assertEq(vault.no().totalSupply(), vault.outstandingSets());
        assertLe(vault.outstandingSets(), vault.issuanceCap());
    }

    /// Custody is exactly deposits - merges - redemptions + donations (no hidden flows).
    function invariant_custodyIdentity() public view {
        assertEq(
            usdc.balanceOf(address(vault)), h.deposited() - h.merged() - h.redeemedPaid() + h.donated()
        );
        assertEq(vault.outstandingSets(), h.deposited() - h.merged());
        assertEq(vault.totalRedeemedAtoms(), h.redeemedPaid());
    }

    /// After resolution: total paid never exceeds the sets backed at resolution, and the remaining
    /// exact liability of all outstanding tokens is still covered by non-donated custody.
    function invariant_payoutsNeverExceedBacking() public view {
        if (!vault.resolved()) return;
        uint256 sets = h.setsAtResolution();
        assertLe(h.redeemedPaid(), sets);
        uint256 p = vault.payoutYesWad();
        uint256 liability = (vault.yes().totalSupply() * p + vault.no().totalSupply() * (1e18 - p)) / 1e18;
        assertLe(h.redeemedPaid() + liability, sets);
        assertLe(liability, usdc.balanceOf(address(vault)) - h.donated());
    }
}
