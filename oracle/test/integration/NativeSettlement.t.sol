pragma solidity ^0.8.30;

import {BookRiskEngine} from "@eros/engine/BookRiskEngine.sol";
import {IPriceSource} from "@eros/interfaces/IPriceSource.sol";
import {MathTypes} from "@eros/math/MathTypes.sol";
import {NativeOutcomeVault} from "@eros/native/NativeOutcomeVault.sol";
import {OutcomeToken} from "@eros/native/OutcomeToken.sol";
import {MarketCore, Outcome} from "../../src/types/OracleTypes.sol";
import {RealMarketFixture} from "./RealMarketFixture.sol";

/// @notice NM-C02 / NM-H02 / NM-H03: a NativeOutcomeVault bound to a real MarketRegistry-listed
///         RegistryBookRiskEngine, resolved through the real ResolutionOracle (sandbox venue double),
///         redeems at exactly the engine's settlement value while perp claims settle separately.
contract NativeSettlementTest is RealMarketFixture {
    bytes32 internal constant MARKET_ID = keccak256("eros-native-settlement");
    uint256 internal constant ONE = 1e6;

    NativeOutcomeVault internal native;
    OutcomeToken internal yes;
    OutcomeToken internal no;
    address internal alice = makeAddr("native-alice");
    address internal bob = makeAddr("native-bob");

    function setUp() public override {
        super.setUp();
        native = _nativeVault(MARKET_ID, REAL_T);
        yes = native.yes();
        no = native.no();
        for (uint256 i; i < 2; ++i) {
            address u = i == 0 ? alice : bob;
            token.mint(u, 1_000 * ONE);
            vm.prank(u);
            token.approve(address(native), type(uint256).max);
        }
    }

    function _nativeVault(bytes32 id, uint64 t) internal returns (NativeOutcomeVault) {
        bytes32 rules = keccak256(bytes(_input(id, false).rules));
        return new NativeOutcomeVault(address(registry), id, usdc, rules, t, 10_000 * ONE, "eYES", "eNO");
    }

    /// List the real engine, bind the vault, and issue: Alice 100 sets, Bob 40 sets.
    function _listBindSplit() internal returns (BookRiskEngine engine) {
        engine = _listReal(MARKET_ID, false);
        assertEq(native.bindMarket(), address(engine));
        vm.prank(alice);
        native.split(100 * ONE, alice);
        vm.prank(bob);
        native.split(40 * ONE, bob);
    }

    function test_bindsToTheRealRegistrySelectedEngine() public {
        BookRiskEngine engine = _listBindSplit();
        MarketCore memory core = registry.getMarketCore(MARKET_ID);
        assertEq(native.engine(), core.engine);
        assertEq(native.engine(), address(engine));
        assertEq(engine.listing().rulesHash, native.rulesHash());
        assertEq(engine.listing().token, native.collateral());
        assertTrue(native.issuanceOpen());
        // Native custody is separate from perp custody.
        assertEq(token.balanceOf(address(native)), 140 * ONE);
        assertEq(vault.marketAtoms(address(engine)), 0);
    }

    function test_bindRejectsUnlistedOrMismatchedEvents() public {
        _listReal(MARKET_ID, false);
        NativeOutcomeVault other = _nativeVault(keccak256("not-listed"), REAL_T);
        vm.expectRevert(NativeOutcomeVault.NotListed.selector);
        other.bindMarket();
        NativeOutcomeVault wrongT = _nativeVault(MARKET_ID, REAL_T + 1);
        vm.expectRevert(abi.encodeWithSelector(NativeOutcomeVault.BindingMismatch.selector, uint8(1)));
        wrongT.bindMarket();
        NativeOutcomeVault wrongRules =
            new NativeOutcomeVault(address(registry), MARKET_ID, usdc, keccak256("other rules"), REAL_T, ONE, "Y", "N");
        vm.expectRevert(abi.encodeWithSelector(NativeOutcomeVault.BindingMismatch.selector, uint8(2)));
        wrongRules.bindMarket();
    }

    function test_earlyYesFinalityPaysYesHoldersAndPerpClaimsStaySeparate() public {
        BookRiskEngine engine = _listBindSplit();
        _trade(engine);
        _enterReview(engine, true);
        // Early review makes the perp reduce-only but does not halt the engine. Complete sets are
        // direction-neutral (each pays exactly 1 in total), so issuance may remain open here.
        assertFalse(engine.getHaltSnapshot().halted);
        assertTrue(native.issuanceOpen());
        vm.expectRevert(NativeOutcomeVault.FinalityNotAccepted.selector);
        native.syncResolution();
        _propose(MARKET_ID, Outcome.YES);
        // The proposal records the early halt: issuance closes, complete sets still exit while pending.
        assertTrue(engine.getHaltSnapshot().halted);
        assertFalse(native.issuanceOpen());
        vm.prank(bob);
        vm.expectRevert(NativeOutcomeVault.IssuanceClosed.selector);
        native.split(ONE, bob);
        vm.prank(bob);
        native.merge(10 * ONE, bob);
        // A proposal alone is not finality.
        vm.expectRevert(NativeOutcomeVault.FinalityNotAccepted.selector);
        native.syncResolution();
        _finalize(MARKET_ID, true);
        // Native sync needs finality only, not completion of the perp payout preparation.
        assertFalse(engine.claimsEnabled());
        assertEq(native.syncResolution(), 1e18);
        assertEq(uint8(native.finalOutcome()), uint8(MathTypes.FinalOutcome.YES));
        vm.prank(alice);
        assertEq(native.redeem(100 * ONE, 100 * ONE, alice), 100 * ONE);
        vm.prank(bob);
        assertEq(native.redeem(0, 30 * ONE, bob), 0);
        vm.prank(bob);
        assertEq(native.redeem(30 * ONE, 0, bob), 30 * ONE);
        assertEq(token.balanceOf(address(native)), 0);
        // Perp claims are paid from CollateralVault after preparation (same values as RealBookOracle).
        _prepare(engine);
        assertEq(vault.claim(address(engine), buyer), 150e6);
        assertEq(vault.claim(address(engine), seller), 50e6);
    }

    function test_scheduledNoPaysNoHolders() public {
        BookRiskEngine engine = _listBindSplit();
        _trade(engine);
        _enterReview(engine, false);
        _propose(MARKET_ID, Outcome.NO);
        _finalize(MARKET_ID, true);
        assertEq(native.syncResolution(), 0);
        assertEq(engine.getSettlementStatus().settlementPriceE18, 0);
        vm.prank(alice);
        assertEq(native.redeem(100 * ONE, 0, alice), 0);
        vm.prank(alice);
        assertEq(native.redeem(0, 100 * ONE, alice), 100 * ONE);
    }

    function test_rejectedProposalCannotOpenRedemption() public {
        BookRiskEngine engine = _listBindSplit();
        _trade(engine);
        _enterReview(engine, false);
        _propose(MARKET_ID, Outcome.YES);
        _finalize(MARKET_ID, false);
        vm.expectRevert(NativeOutcomeVault.FinalityNotAccepted.selector);
        native.syncResolution();
        _propose(MARKET_ID, Outcome.NO);
        _finalize(MARKET_ID, true);
        assertEq(native.syncResolution(), 0);
        assertEq(uint8(engine.finalOutcome()), uint8(MathTypes.FinalOutcome.NO));
    }

    function test_invalidWithMissingHistoryWaitsForGraceThenMatchesEngineHalf() public {
        BookRiskEngine engine = _listBindSplit();
        _trade(engine);
        _enterReview(engine, true);
        _propose(MARKET_ID, Outcome.INVALID);
        _finalize(MARKET_ID, true);
        // INVALID is final but its price is not captured yet: the reported 0 is not a NO payout.
        assertFalse(engine.getSettlementStatus().invalidPriceReady);
        vm.expectRevert(NativeOutcomeVault.InvalidPricePending.selector);
        native.syncResolution();
        vm.warp(REAL_T + 1 hours);
        (, bool captured) = engine.captureInvalidPrice();
        assertTrue(captured);
        uint256 enginePrice = engine.getSettlementStatus().settlementPriceE18;
        assertEq(enginePrice, 0.5e18);
        assertEq(native.syncResolution(), enginePrice);
        vm.prank(alice);
        assertEq(native.redeem(100 * ONE, 0, alice), 50 * ONE);
        vm.prank(alice);
        assertEq(native.redeem(0, 100 * ONE, alice), 50 * ONE);
    }

    /// INVALID with a complete [T-24h, T] INDEX history at 0.63: the engine captures 0.63 itself and
    /// native YES/NO redeem at 0.63/0.37, matching the perp settlement value exactly.
    function test_invalidWithCompleteHistoryPaysNonHalfEnginePrice() public {
        BookRiskEngine engine = _listBindSplit();
        _trade(engine); // warms INDEX at 0.50 for 300 s from NOW
        uint64 sequence = 32;
        while (block.timestamp + 100 < REAL_T) {
            vm.warp(block.timestamp + 100); // < 120 s testnet INDEX carry: contiguous coverage
            _publish(engine, sequence++, 0.62e18, 0.64e18);
        }
        _enterReview(engine, false); // warps to T and halts
        _propose(MARKET_ID, Outcome.INVALID);
        _finalize(MARKET_ID, true);
        (, bool captured) = engine.captureInvalidPrice();
        assertTrue(captured);
        uint256 enginePrice = engine.getSettlementStatus().settlementPriceE18;
        assertEq(enginePrice, 0.63e18);
        assertEq(native.syncResolution(), enginePrice);
        assertEq(native.redeemValue(ONE, 0), 630_000);
        assertEq(native.redeemValue(0, ONE), 370_000);
        vm.prank(alice);
        assertEq(native.redeem(100 * ONE, 100 * ONE, alice), 100 * ONE);
        vm.prank(bob);
        assertEq(native.redeem(40 * ONE, 0, bob), 25_200_000);
        _prepare(engine);
    }

    function _publish(BookRiskEngine engine, uint64 sequence, uint256 bid, uint256 ask) internal {
        IPriceSource.Observation memory o = _observation(engine, sequence);
        o.impactBidWad = bid;
        o.impactAskWad = ask;
        o.priceWad = (bid + ask) / 2;
        engine.submitObservation(o, _sign(INDEX_KEY, engine.observationDigest(o)));
    }
}
