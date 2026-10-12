// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "solady/tokens/ERC20.sol";
import {MathTypes} from "../../src/math/MathTypes.sol";
import {RegistryMarketCore} from "../../src/native/INativeMarketReads.sol";
import {NativeOutcomeVault} from "../../src/native/NativeOutcomeVault.sol";
import {OutcomeToken} from "../../src/native/OutcomeToken.sol";
import {MockCollateral, MockEngine, MockRegistry, ReentrantCollateral, ShortCollateral} from "./NativeMocks.sol";

/// @notice NM-C01..C07: outcome tokens, binding, split/merge, resolution sync and redemption.
///         Expected values are hand arithmetic (1 collateral atom = 1 YES atom + 1 NO atom).
contract NativeVaultFixture is Test {
    bytes32 internal constant MARKET = keccak256("eros-native-demo");
    bytes32 internal constant RULES = keccak256("Will X happen by T? YES if ..., NO otherwise.");
    address internal constant ORACLE = address(0x0A11CE);
    uint256 internal constant ONE = 1e6; // one whole claim / one collateral unit
    uint256 internal constant CAP = 10_000 * ONE;

    uint64 internal T;
    MockCollateral internal usdc;
    MockRegistry internal reg;
    MockEngine internal eng;
    NativeOutcomeVault internal vault;
    OutcomeToken internal yes;
    OutcomeToken internal no;

    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");

    function setUp() public virtual {
        vm.warp(1_800_000_000);
        T = uint64(block.timestamp + 2 days);
        usdc = new MockCollateral(6);
        reg = new MockRegistry();
        eng = new MockEngine();
        vault = _deployVault(address(usdc));
        yes = vault.yes();
        no = vault.no();
        _list(address(eng), T, RULES);
        eng.setListing(MARKET, address(usdc), address(reg), T, RULES, ORACLE);
        for (uint256 i; i < 2; ++i) {
            address u = i == 0 ? alice : bob;
            usdc.mint(u, 1_000_000 * ONE);
            vm.prank(u);
            usdc.approve(address(vault), type(uint256).max);
        }
    }

    function _deployVault(address coll) internal returns (NativeOutcomeVault) {
        return new NativeOutcomeVault(address(reg), MARKET, coll, RULES, T, CAP, "eYES", "eNO");
    }

    function _list(address engine, uint64 tau, bytes32 rules) internal {
        RegistryMarketCore memory c;
        c.engine = engine;
        c.tau = tau;
        c.rulesHash = rules;
        reg.setCore(MARKET, c);
    }

    function _bind() internal {
        vault.bindMarket();
    }

    function _split(address u, uint256 atoms) internal {
        vm.prank(u);
        vault.split(atoms, u);
    }

    function _resolve(MathTypes.FinalOutcome o, uint256 invalidPrice) internal {
        eng.setHalted(true);
        eng.setOutcome(o, o == MathTypes.FinalOutcome.INVALID, invalidPrice);
        vault.syncResolution();
    }
}

contract OutcomeTokenTest is NativeVaultFixture {
    function test_tokenIdentity() public view {
        assertEq(yes.decimals(), 6);
        assertEq(no.decimals(), 6);
        assertEq(yes.vault(), address(vault));
        assertEq(yes.marketId(), MARKET);
        assertTrue(yes.isYes());
        assertFalse(no.isYes());
        assertEq(yes.symbol(), "eYES");
        assertEq(yes.name(), "Eros YES eYES");
    }

    function test_onlyVaultMintsAndBurns() public {
        vm.expectRevert(OutcomeToken.OnlyVault.selector);
        yes.mint(alice, 1);
        _bind();
        _split(alice, ONE);
        vm.prank(alice);
        vm.expectRevert(OutcomeToken.OnlyVault.selector);
        yes.burn(alice, 1);
    }

    function test_transfersAndAllowancesAreStandard() public {
        _bind();
        _split(alice, 5 * ONE);
        vm.prank(alice);
        yes.transfer(bob, 2 * ONE);
        assertEq(yes.balanceOf(bob), 2 * ONE);
        // No implicit Permit2 allowance.
        assertEq(yes.allowance(alice, 0x000000000022D473030F116dDEE9F6B43aC78BA3), 0);
        vm.prank(alice);
        yes.approve(bob, ONE);
        vm.prank(bob);
        yes.transferFrom(alice, bob, ONE);
        assertEq(yes.balanceOf(bob), 3 * ONE);
    }
}

contract OutcomeVaultBindingTest is NativeVaultFixture {
    function test_constructorRejectsBadConfig() public {
        MockCollateral wad18 = new MockCollateral(18);
        vm.expectRevert(NativeOutcomeVault.BadConfig.selector);
        new NativeOutcomeVault(address(reg), MARKET, address(wad18), RULES, T, CAP, "Y", "N");
        vm.expectRevert(NativeOutcomeVault.BadConfig.selector);
        new NativeOutcomeVault(address(reg), MARKET, address(usdc), RULES, uint64(block.timestamp), CAP, "Y", "N");
        vm.expectRevert(NativeOutcomeVault.BadConfig.selector);
        new NativeOutcomeVault(address(reg), MARKET, address(usdc), RULES, T, 0, "Y", "N");
        vm.expectRevert(NativeOutcomeVault.BadConfig.selector);
        new NativeOutcomeVault(address(reg), bytes32(0), address(usdc), RULES, T, CAP, "Y", "N");
    }

    function test_unboundVaultCannotIssueOrMerge() public {
        assertFalse(vault.issuanceOpen());
        vm.prank(alice);
        vm.expectRevert(NativeOutcomeVault.IssuanceClosed.selector);
        vault.split(ONE, alice);
        vm.prank(alice);
        vm.expectRevert(NativeOutcomeVault.NotBound.selector);
        vault.merge(ONE, alice);
        vm.expectRevert(NativeOutcomeVault.NotBound.selector);
        vault.syncResolution();
    }

    function test_bindUnlistedReverts() public {
        reg.setCore(MARKET, RegistryMarketCore({
            engine: address(0), questionPtr: address(0), rulesPtr: address(0), listedAt: 0, windowStart: 0,
            windowEnd: 0, tau: 0, groupId: 0, groupExclusive: false, hasFeed: false, l2DeadlineSecs: 0,
            voidSecs: 0, retryWindowSecs: 0, earlyTtlSecs: 0, monitor: address(0), oiCapLots: 0,
            rulesHash: 0, specHash: 0, gateHash: 0
        }));
        vm.expectRevert(NativeOutcomeVault.NotListed.selector);
        vault.bindMarket();
    }

    function test_bindLatchesRegistryEngineOnce() public {
        assertEq(vault.bindMarket(), address(eng));
        assertEq(vault.engine(), address(eng));
        assertTrue(vault.issuanceOpen());
        vm.expectRevert(NativeOutcomeVault.AlreadyBound.selector);
        vault.bindMarket();
    }

    function test_bindRejectsRegistryMismatch() public {
        _list(address(eng), T + 1, RULES);
        vm.expectRevert(abi.encodeWithSelector(NativeOutcomeVault.BindingMismatch.selector, uint8(1)));
        vault.bindMarket();
        _list(address(eng), T, keccak256("other rules"));
        vm.expectRevert(abi.encodeWithSelector(NativeOutcomeVault.BindingMismatch.selector, uint8(2)));
        vault.bindMarket();
    }

    function test_bindRejectsEngineListingMismatch() public {
        eng.setListing(keccak256("other"), address(usdc), address(reg), T, RULES, ORACLE);
        _expectMismatch(3);
        eng.setListing(MARKET, address(0xBEEF), address(reg), T, RULES, ORACLE);
        _expectMismatch(4);
        eng.setListing(MARKET, address(usdc), address(0xBEEF), T, RULES, ORACLE);
        _expectMismatch(5);
        eng.setListing(MARKET, address(usdc), address(reg), T + 1, RULES, ORACLE);
        _expectMismatch(6);
        eng.setListing(MARKET, address(usdc), address(reg), T, keccak256("x"), ORACLE);
        _expectMismatch(7);
        eng.setListing(MARKET, address(usdc), address(reg), T, RULES, address(0));
        _expectMismatch(8);
        assertEq(vault.engine(), address(0));
    }

    function _expectMismatch(uint8 field) internal {
        vm.expectRevert(abi.encodeWithSelector(NativeOutcomeVault.BindingMismatch.selector, field));
        vault.bindMarket();
    }
}

contract OutcomeVaultIssuanceTest is NativeVaultFixture {
    function setUp() public override {
        super.setUp();
        _bind();
    }

    function test_splitMintsEqualSetsForExactCollateral() public {
        uint256 before = usdc.balanceOf(alice);
        vm.prank(alice);
        vault.split(100 * ONE, bob);
        assertEq(usdc.balanceOf(alice), before - 100 * ONE);
        assertEq(usdc.balanceOf(address(vault)), 100 * ONE);
        assertEq(yes.balanceOf(bob), 100 * ONE);
        assertEq(no.balanceOf(bob), 100 * ONE);
        assertEq(yes.totalSupply(), no.totalSupply());
        assertEq(vault.outstandingSets(), 100 * ONE);
    }

    function test_splitMergeRoundTripIsExact() public {
        uint256 before = usdc.balanceOf(alice);
        _split(alice, 100 * ONE);
        vm.prank(alice);
        vault.merge(100 * ONE, alice);
        assertEq(usdc.balanceOf(alice), before);
        assertEq(yes.totalSupply(), 0);
        assertEq(no.totalSupply(), 0);
        assertEq(vault.outstandingSets(), 0);
        assertEq(usdc.balanceOf(address(vault)), 0);
    }

    function test_splitRejectsZeroAndZeroReceiver() public {
        vm.startPrank(alice);
        vm.expectRevert(NativeOutcomeVault.ZeroAmount.selector);
        vault.split(0, alice);
        vm.expectRevert(NativeOutcomeVault.ZeroReceiver.selector);
        vault.split(ONE, address(0));
        vm.stopPrank();
    }

    function test_issuanceCapIsEnforcedOnOutstandingSets() public {
        _split(alice, CAP);
        vm.prank(bob);
        vm.expectRevert(NativeOutcomeVault.CapExceeded.selector);
        vault.split(1, bob);
        // Merging frees capacity again.
        vm.prank(alice);
        vault.merge(ONE, alice);
        _split(bob, ONE);
        assertEq(vault.outstandingSets(), CAP);
    }

    function test_splitClosesAtScheduledTWithoutKeeperHalt() public {
        vm.warp(T - 1);
        _split(alice, ONE);
        vm.warp(T);
        assertFalse(eng.halted());
        vm.prank(alice);
        vm.expectRevert(NativeOutcomeVault.IssuanceClosed.selector);
        vault.split(ONE, alice);
    }

    function test_splitClosesOnEarlyEngineHalt() public {
        eng.setHalted(true);
        vm.prank(alice);
        vm.expectRevert(NativeOutcomeVault.IssuanceClosed.selector);
        vault.split(ONE, alice);
    }

    function test_mergeStillWorksAfterHaltWhileOutcomePending() public {
        _split(alice, 10 * ONE);
        vm.warp(T + 1);
        eng.setHalted(true);
        vm.prank(alice);
        vault.merge(10 * ONE, bob);
        assertEq(usdc.balanceOf(bob), 1_000_000 * ONE + 10 * ONE);
    }

    function test_mergeOnlyBurnsCallerOwnedTokens() public {
        _split(alice, 10 * ONE);
        // Bob holds nothing: he cannot merge Alice's sets by naming himself or her as receiver.
        vm.prank(bob);
        vm.expectRevert(ERC20.InsufficientBalance.selector);
        vault.merge(10 * ONE, bob);
        // Holding only one side is not a complete set.
        vm.prank(alice);
        yes.transfer(bob, 10 * ONE);
        vm.prank(alice);
        vm.expectRevert(ERC20.InsufficientBalance.selector);
        vault.merge(1, alice);
        assertEq(vault.outstandingSets(), 10 * ONE);
    }

    function test_donationCreatesNoClaims() public {
        _split(alice, 10 * ONE);
        vm.prank(bob);
        usdc.transfer(address(vault), 500 * ONE);
        assertEq(vault.outstandingSets(), 10 * ONE);
        assertEq(yes.totalSupply(), 10 * ONE);
        // Cap accounting ignores donations.
        _split(bob, CAP - 10 * ONE);
        assertEq(vault.outstandingSets(), CAP);
    }

    function test_shortTransferCollateralIsRejected() public {
        ShortCollateral sc = new ShortCollateral();
        NativeOutcomeVault v2 = _deployVault(address(sc));
        eng.setListing(MARKET, address(sc), address(reg), T, RULES, ORACLE);
        v2.bindMarket();
        sc.mint(alice, 100 * ONE);
        vm.startPrank(alice);
        sc.approve(address(v2), type(uint256).max);
        vm.expectRevert(NativeOutcomeVault.ShortTransfer.selector);
        v2.split(100 * ONE, alice);
        vm.stopPrank();
        assertEq(v2.yes().totalSupply(), 0);
    }

    function test_reentrancyDuringSplitIsBlocked() public {
        ReentrantCollateral rc = new ReentrantCollateral();
        NativeOutcomeVault v2 = _deployVault(address(rc));
        eng.setListing(MARKET, address(rc), address(reg), T, RULES, ORACLE);
        v2.bindMarket();
        rc.mint(alice, 100 * ONE);
        vm.prank(alice);
        rc.approve(address(v2), type(uint256).max);
        rc.arm(address(v2), abi.encodeCall(NativeOutcomeVault.merge, (1, alice)));
        vm.prank(alice);
        v2.split(10 * ONE, alice);
        assertTrue(rc.reentered());
        // The nested merge reverted with Solady's Reentrancy() error.
        assertEq(bytes4(rc.reentryError()), bytes4(keccak256("Reentrancy()")));
        assertEq(v2.outstandingSets(), 10 * ONE);
    }

    function testFuzz_splitMergeConserves(uint256 a, uint256 m) public {
        a = bound(a, 1, CAP);
        m = bound(m, 1, a);
        uint256 before = usdc.balanceOf(alice);
        _split(alice, a);
        vm.prank(alice);
        vault.merge(m, alice);
        assertEq(usdc.balanceOf(alice), before - a + m);
        assertEq(yes.totalSupply(), a - m);
        assertEq(no.totalSupply(), a - m);
        assertEq(usdc.balanceOf(address(vault)), a - m);
    }
}

contract OutcomeVaultResolutionTest is NativeVaultFixture {
    function setUp() public override {
        super.setUp();
        _bind();
        _split(alice, 100 * ONE);
        _split(bob, 50 * ONE);
    }

    function test_syncRequiresAcceptedFinality() public {
        eng.setHalted(true);
        vm.expectRevert(NativeOutcomeVault.FinalityNotAccepted.selector);
        vault.syncResolution();
        vm.expectRevert(NativeOutcomeVault.NotResolved.selector);
        vault.redeemValue(1, 1);
    }

    function test_yesPaysOnePerYes() public {
        _resolve(MathTypes.FinalOutcome.YES, 0);
        assertEq(vault.payoutYesWad(), 1e18);
        uint256 before = usdc.balanceOf(alice);
        vm.prank(alice);
        uint256 paid = vault.redeem(100 * ONE, 100 * ONE, alice);
        assertEq(paid, 100 * ONE);
        assertEq(usdc.balanceOf(alice), before + 100 * ONE);
        assertEq(yes.balanceOf(alice), 0);
        assertEq(no.balanceOf(alice), 0);
    }

    function test_noPaysOnePerNoAndLosersBurnForZero() public {
        _resolve(MathTypes.FinalOutcome.NO, 0);
        assertEq(vault.payoutYesWad(), 0);
        vm.prank(bob);
        assertEq(vault.redeem(50 * ONE, 0, bob), 0);
        assertEq(yes.balanceOf(bob), 0);
        vm.prank(bob);
        assertEq(vault.redeem(0, 50 * ONE, bob), 50 * ONE);
    }

    function test_invalidWaitsForPriceThenPaysEnginePrice() public {
        eng.setHalted(true);
        eng.setOutcome(MathTypes.FinalOutcome.INVALID, false, 0);
        // Pending INVALID reports price 0; that must not be read as a NO payout.
        vm.expectRevert(NativeOutcomeVault.InvalidPricePending.selector);
        vault.syncResolution();
        eng.setOutcome(MathTypes.FinalOutcome.INVALID, true, 0.63e18);
        assertEq(vault.syncResolution(), 0.63e18);
        // One YES = 0.63, one NO = 0.37, one full set = exactly 1.
        assertEq(vault.redeemValue(ONE, 0), 630_000);
        assertEq(vault.redeemValue(0, ONE), 370_000);
        assertEq(vault.redeemValue(ONE, ONE), ONE);
        vm.prank(alice);
        assertEq(vault.redeem(100 * ONE, 100 * ONE, alice), 100 * ONE);
    }

    function test_invalidMissingHistoryFallbackHalf() public {
        _resolve(MathTypes.FinalOutcome.INVALID, 0.5e18);
        assertEq(vault.redeemValue(3, 0), 1); // floor(1.5)
        assertEq(vault.redeemValue(3, 3), 3);
    }

    function test_syncLatchesOnceAndIgnoresLaterEngineChanges() public {
        _resolve(MathTypes.FinalOutcome.YES, 0);
        eng.setOutcome(MathTypes.FinalOutcome.NO, false, 0);
        assertEq(vault.syncResolution(), 1e18);
        assertEq(uint8(vault.finalOutcome()), uint8(MathTypes.FinalOutcome.YES));
    }

    function test_rejectsOutOfRangeEnginePrice() public {
        eng.setHalted(true);
        eng.setOutcome(MathTypes.FinalOutcome.INVALID, true, 1e18 + 1);
        vm.expectRevert(NativeOutcomeVault.BadSettlementPrice.selector);
        vault.syncResolution();
    }

    function test_issuanceAndMergeCloseAtResolution() public {
        _resolve(MathTypes.FinalOutcome.YES, 0);
        vm.prank(alice);
        vm.expectRevert(NativeOutcomeVault.Resolved.selector);
        vault.merge(ONE, alice);
        vm.prank(alice);
        vm.expectRevert(NativeOutcomeVault.IssuanceClosed.selector);
        vault.split(ONE, alice);
    }

    function test_redeemOnlyBurnsCallerOwnedTokens() public {
        _resolve(MathTypes.FinalOutcome.YES, 0);
        address mallory = makeAddr("mallory");
        vm.prank(mallory);
        vm.expectRevert(ERC20.InsufficientBalance.selector);
        vault.redeem(ONE, 0, mallory);
        vm.prank(mallory);
        vm.expectRevert(NativeOutcomeVault.ZeroAmount.selector);
        vault.redeem(0, 0, mallory);
    }

    function test_transfersRemainOpenAfterResolution() public {
        _resolve(MathTypes.FinalOutcome.YES, 0);
        vm.prank(alice);
        yes.transfer(bob, ONE);
        vm.prank(bob);
        assertEq(vault.redeem(51 * ONE, 0, bob), 51 * ONE);
    }

    /// @dev Fragmented redemptions at an arbitrary price never pay more than the sets backing them.
    function testFuzz_fragmentedRedemptionNeverOverpays(uint256 p, uint256 chunk) public {
        p = bound(p, 0, 1e18);
        chunk = bound(chunk, 1, 50);
        _resolve(MathTypes.FinalOutcome.INVALID, p);
        uint256 vaultBefore = usdc.balanceOf(address(vault));
        // Fragment the first 2,000 atoms into tiny one-sided redemptions (worst rounding case),
        // then redeem the remainder of Alice's 100 sets as one-sided lumps.
        uint256 left = 2_000;
        vm.startPrank(alice);
        while (left != 0) {
            uint256 y = left < chunk ? left : chunk;
            vault.redeem(y, 0, alice);
            vault.redeem(0, y, alice);
            left -= y;
        }
        vault.redeem(100 * ONE - 2_000, 0, alice);
        vault.redeem(0, 100 * ONE - 2_000, alice);
        vm.stopPrank();
        uint256 paid = vaultBefore - usdc.balanceOf(address(vault));
        assertLe(paid, 100 * ONE);
        assertEq(paid, vault.totalRedeemedAtoms());
        // Bob's 50 full sets remain fully covered.
        assertGe(usdc.balanceOf(address(vault)), 50 * ONE);
    }
}
