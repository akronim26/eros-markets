// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {stdJson} from "forge-std/StdJson.sol";
import {IMarketConfig} from "@eros/interfaces/IMarketConfig.sol";
import {MathTypes} from "@eros/math/MathTypes.sol";
import {NativeOutcomeVault} from "@eros/native/NativeOutcomeVault.sol";
import {FeedSpec, FinalizeStatus, Globals, MarketInput, Outcome, Path, RState} from "../../src/types/OracleTypes.sol";
import {IResolutionOracle} from "../../src/interfaces/IResolutionOracle.sol";
import {SpotMarketFactory} from "../../src/native/SpotMarketFactory.sol";
import {SpotResolutionAnchor} from "../../src/native/SpotResolutionAnchor.sol";
import {ListNativeSpotMarket} from "../../script/native/ListNativeSpotMarket.s.sol";
import {OracleFixture} from "../unit/OracleFixture.sol";

/// @notice NM-S05: a native spot prediction market end to end on the real MarketRegistry, BondTreasury
///         and ResolutionOracle, with the canonical API-Sports basketball feed of the listed market
///         (`listings/native/nba-gsw-mia-20261105-spot`), the testnet globals (2026-10-13 read) with
///         only the two Layer-1 timing maxima raised, and the real dates of the game.
///         Path: list (spot factory → anchor) → bind vault → split → halt at T → Layer-1 report through
///         the sim forwarder → assertion → liveness → Final → vault sync → redeem.
///         The only doubles are the fixture's: MockAssertionVenue (scripted UMA result) and MockUSDC.
/// @dev Expected payouts are hand arithmetic on 100 (Alice) and 40 (Bob) complete sets.
contract NativeSpotMarketTest is OracleFixture {
    using stdJson for string;

    string internal constant DIR = "listings/native/nba-gsw-mia-20261105-spot/";
    uint64 internal constant LIST_AT = 1_792_000_000; // 2026-10-14T00:26:40Z
    uint64 internal constant TIP_OFF = 1_793_934_000; // 2026-11-06T03:00:00Z (API-Sports game 519655)
    uint256 internal constant ONE = 1e6;

    SpotMarketFactory internal spotFactory;
    ListNativeSpotMarket internal lister_;
    NativeOutcomeVault internal native;
    SpotResolutionAnchor internal anchor;
    bytes32 internal id;
    FeedSpec internal feed;
    string internal rules;

    address internal relayer = makeAddr("sim relayer");
    address internal alice = makeAddr("spot-alice");
    address internal bob = makeAddr("spot-bob");

    function setUp() public override {
        super.setUp();
        vm.warp(LIST_AT);
        string memory listing = vm.readFile(string.concat(DIR, "listing.json"));
        string memory f = vm.readFile(string.concat(DIR, "feed.json"));
        lister_ = new ListNativeSpotMarket();
        feed = lister_.readFeed(f);
        rules = listing.readString(".rules");
        id = keccak256("eros-native-spot:basketball:519655:gsw-mia-20261105");

        spotFactory = new SpotMarketFactory(address(reg));
        string[] memory hosts = listing.readStringArray(".evidenceHosts");
        vm.startPrank(gov);
        reg.setGlobals(_testnetGlobals());
        for (uint256 i; i < hosts.length; ++i) {
            reg.setProvider(hosts[i], true);
        }
        reg.setAuthRef(feed.authRef, true);
        reg.setFactory(address(spotFactory));
        ro.setSimForwarder(mockForwarder);
        ro.setSimRelayer(relayer, true);
        vm.stopPrank();

        native = new NativeOutcomeVault(address(reg), id, usdc, keccak256(bytes(rules)), TIP_OFF, 10_000 * ONE, "Y", "N");
        anchor = SpotResolutionAnchor(_listSpot(listing, hosts));
        assertEq(native.bindMarket(), address(anchor));
        for (uint256 i; i < 2; ++i) {
            address u = i == 0 ? alice : bob;
            token.mint(u, 1_000 * ONE);
            vm.prank(u);
            token.approve(address(native), type(uint256).max);
        }
        vm.prank(alice);
        native.split(100 * ONE, alice);
        vm.prank(bob);
        native.split(40 * ONE, bob);
    }

    // ------------------------------------------------------------------ helpers

    /// Monad testnet globals as read from the registry on 2026-10-13, with `bufferMaxSecs` and
    /// `l1TimeoutMaxSecs` raised to the canonical sports feed (the SpotMarketGovernance change).
    function _testnetGlobals() internal pure returns (Globals memory g) {
        g = Globals(600, 2_588_400, 2_592_000, 60, 3_600, 60, 7_200, 120, 21_600, 60, 1_112, 5_000, 16_384, 300, 0,
            600, 600, 300, 600, 60, 900, 200, 150, 1_668_000_000, 0);
    }

    function _listSpot(string memory listing, string[] memory hosts) internal returns (address) {
        MarketInput memory m = _market(); // AI/UMA/template values of the fixture's listed markets
        m.marketId = id;
        m.question = listing.readString(".question");
        m.rules = rules;
        m.windowStart = LIST_AT;
        m.tau = TIP_OFF;
        m.windowEnd = TIP_OFF;
        m.hasFeed = true;
        m.feed = feed;
        m.allowList = hosts;
        m.voidSecs = uint32(listing.readUint(".voidSecs"));
        m.oiCapLots = listing.readUint(".oiCapLots");
        IMarketConfig.Listing memory l;
        l.token = usdc;
        vm.prank(lister);
        return reg.createMarket(m, l, "");
    }

    function _report(uint8 outcome, uint64 observedAt) internal view returns (bytes memory) {
        return abi.encode(uint8(1), SELECTOR, address(ro), id, outcome, observedAt, keccak256("evidence"),
            keccak256(abi.encode(feed)));
    }

    /// Halt at T, request at T + buffer, deliver the Layer-1 report as the CRE simulator does.
    function _reportL1(uint8 outcome) internal {
        vm.warp(TIP_OFF);
        assertTrue(ro.haltScheduled(id));
        vm.warp(TIP_OFF + feed.bufferSecs);
        assertTrue(ro.requestResolution(id));
        vm.prank(mockForwarder, relayer);
        ro.onReport("", _report(outcome, uint64(block.timestamp)));
    }

    function _assertAndSettle(bool truthful) internal {
        assertTrue(ro.assertProposal(id));
        bytes32 assertion = ro.getResolution(id).assertionId;
        vm.warp(block.timestamp + ro.livenessFor(id));
        mvenue.setResult(assertion, truthful);
        ro.finalizeMarket(id);
    }

    // ------------------------------------------------------------------ listing

    function test_listsASpotAnchorWithTheCanonicalBasketballFeed() public view {
        assertEq(reg.getMarketCore(id).engine, address(anchor));
        assertEq(spotFactory.anchorOf(id), address(anchor));
        assertEq(reg.getSpecHash(id), vm.readFile(string.concat(DIR, "feed.json")).readBytes32(".specHash"));
        (, FeedSpec memory onChain,, ) = ro.getL1Job(id);
        assertEq(onChain.urlTemplate, "https://v1.basketball.api-sports.io/games?id={id}");
        assertEq(onChain.urlParam, "519655");
        IMarketConfig.Listing memory l = anchor.listing();
        assertEq(l.resolutionAuthority, address(ro));
        assertEq(l.invalidRule.fallbackPriceWad, 5e17);
        assertTrue(native.issuanceOpen());
        assertEq(token.balanceOf(address(native)), 140 * ONE);
        assertEq(native.outstandingSets(), 140 * ONE);
    }

    function test_spotListingRejectsEngineInitAndDirectDeploys() public {
        vm.expectRevert(SpotMarketFactory.OnlyRegistry.selector);
        IMarketConfig.Listing memory l;
        spotFactory.deployMarket(l, "");
        SpotResolutionAnchor a = new SpotResolutionAnchor();
        vm.prank(makeAddr("not factory"));
        vm.expectRevert(SpotResolutionAnchor.RiskUnauthorized.selector);
        a.initialize(l, "");
    }

    // ------------------------------------------------------------------ lifecycle

    function test_issuanceClosesAtTipOffButSetsStillMerge() public {
        vm.warp(TIP_OFF - 1);
        assertTrue(native.issuanceOpen());
        vm.warp(TIP_OFF);
        assertFalse(native.issuanceOpen());
        vm.prank(bob);
        vm.expectRevert(NativeOutcomeVault.IssuanceClosed.selector);
        native.split(ONE, bob);
        assertTrue(ro.haltScheduled(id));
        assertEq(uint8(ro.getResolution(id).state), uint8(RState.L1Pending));
        assertEq(anchor.getHaltSnapshot().economicHaltAt, TIP_OFF);
        assertEq(anchor.getHaltSnapshot().oiHaltLots, 0);
        // No perp open interest: the assertion bond is the market's minimum bond (2 tUSDC).
        assertEq(ro.bondFor(id), 2e6);
        vm.prank(bob);
        native.merge(10 * ONE, bob);
        assertEq(token.balanceOf(bob), 970 * ONE);
    }

    function test_requestsWaitForTheFeedBuffer() public {
        vm.warp(TIP_OFF + feed.bufferSecs - 1);
        vm.expectRevert(IResolutionOracle.TooEarly.selector);
        ro.requestResolution(id);
    }

    function test_warriorsWinPaysYesHolders() public {
        _reportL1(uint8(Outcome.YES));
        assertEq(uint8(ro.getResolution(id).state), uint8(RState.Proposed));
        assertEq(uint8(ro.getResolution(id).path), uint8(Path.L1));
        vm.expectRevert(NativeOutcomeVault.FinalityNotAccepted.selector);
        native.syncResolution();
        _assertAndSettle(true);
        assertEq(uint8(ro.getResolution(id).state), uint8(RState.Final));
        assertEq(native.syncResolution(), 1e18);
        assertEq(uint8(native.finalOutcome()), uint8(MathTypes.FinalOutcome.YES));
        vm.prank(alice);
        assertEq(native.redeem(100 * ONE, 100 * ONE, alice), 100 * ONE);
        vm.prank(bob);
        assertEq(native.redeem(40 * ONE, 0, bob), 40 * ONE);
        vm.prank(bob);
        assertEq(native.redeem(0, 40 * ONE, bob), 0);
        assertEq(token.balanceOf(address(native)), 0);
    }

    function test_heatWinPaysNoHolders() public {
        _reportL1(uint8(Outcome.NO));
        _assertAndSettle(true);
        assertEq(native.syncResolution(), 0);
        vm.prank(alice);
        assertEq(native.redeem(100 * ONE, 0, alice), 0);
        vm.prank(alice);
        assertEq(native.redeem(0, 100 * ONE, alice), 100 * ONE);
    }

    function test_rejectedReportDoesNotOpenRedemption() public {
        _reportL1(uint8(Outcome.YES));
        _assertAndSettle(false);
        assertTrue(ro.getResolution(id).state != RState.Final);
        vm.expectRevert(NativeOutcomeVault.FinalityNotAccepted.selector);
        native.syncResolution();
    }

    function test_unresolvedAtVoidDeadlinePaysHalfPerToken() public {
        vm.warp(TIP_OFF);
        ro.haltScheduled(id);
        uint64 deadline = ro.getResolution(id).voidDeadline;
        assertEq(deadline, TIP_OFF + 2_592_000);
        vm.warp(deadline);
        assertTrue(ro.voidMarket(id));
        assertEq(uint8(ro.getResolution(id).outcome), uint8(Outcome.INVALID));
        assertEq(native.syncResolution(), 5e17);
        // 100 YES -> 50; 100 NO -> 50; a complete set redeems for exactly one unit.
        vm.prank(alice);
        assertEq(native.redeem(100 * ONE, 0, alice), 50 * ONE);
        vm.prank(alice);
        assertEq(native.redeem(0, 100 * ONE, alice), 50 * ONE);
        vm.prank(bob);
        assertEq(native.redeem(40 * ONE, 40 * ONE, bob), 40 * ONE);
        assertEq(token.balanceOf(address(native)), 0);
    }

    function test_anchorAcceptsOnlyTheOracleAndOneOutcome() public {
        vm.expectRevert(SpotResolutionAnchor.RiskUnauthorized.selector);
        anchor.settle(1);
        vm.expectRevert(SpotResolutionAnchor.RiskUnauthorized.selector);
        anchor.halt();
        vm.expectRevert(SpotResolutionAnchor.ScheduledHaltNotYet.selector);
        anchor.materializeScheduledHalt();
        vm.startPrank(address(ro));
        assertTrue(anchor.settle(1));
        assertFalse(anchor.settle(1));
        vm.expectRevert(SpotResolutionAnchor.ConflictingFinalOutcome.selector);
        anchor.settle(0);
        vm.expectRevert(SpotResolutionAnchor.ConflictingFinalOutcome.selector);
        anchor.settleInvalid();
        vm.stopPrank();
        assertEq(anchor.getSettlementStatus().settlementPriceE18, 1e18);
    }
}
