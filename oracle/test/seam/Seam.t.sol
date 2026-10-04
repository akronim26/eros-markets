// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {MockUSDC} from "@eros-test/mocks/A/MockUSDC.sol";
import {IAccountingPort} from "@eros/interfaces/IAccountingPort.sol";
import {MathTypes} from "@eros/math/MathTypes.sol";
import {LifecycleMath} from "@eros/math/LifecycleMath.sol";
import {HaltView} from "@eros/interfaces/IResolutionIngress.sol";
import {SettlementController} from "@eros/settlement/SettlementController.sol";
import {
    Ledger,
    MarketInput,
    Outcome,
    Path,
    Phase,
    PanelLabel,
    PanelResult,
    Resolution,
    ReviewedProposal,
    RState,
    Sig,
    TrustSetInput
} from "../../src/types/OracleTypes.sol";
import {IResolutionOracle} from "../../src/interfaces/IResolutionOracle.sol";
import {ResolutionOracle} from "../../src/ResolutionOracle.sol";
import {MarketRegistry} from "../../src/MarketRegistry.sol";
import {BondTreasury} from "../../src/BondTreasury.sol";
import {RegistryFixture} from "../unit/RegistryFixture.sol";
import {MockAssertionVenue} from "../mocks/MockAssertionVenue.sol";
import {EngineHarness, SeamFactory, SeamFixture} from "./EngineHarness.sol";

/// @notice Task O17.3: the seam with B's real settlement code (plan §3.2, §3.4, B.6, V-R1). The real
///         MarketRegistry, BondTreasury and ResolutionOracle list a market whose engine is B's real
///         `SettlementController` (with B's book and accounting mocks), pinned with
///         `resolutionAuthority = ResolutionOracle`, and drive it through the oracle's own entry points.
/// @dev The real engine needs T at least a day after listing and `T + 1 h <= listedAt + voidSecs`: T is
///      listing + 25 h and voidSecs 26 h (plan §14: 26 h with the real engine). The accounting mock is
///      scripted as B scripts it: 3 accounts, 100,000 lots of OI frozen at the halt, and a reconciled
///      finish. Claims open through the engine's permissionless jobs (snapshot, payout, finish).
contract SeamTest is RegistryFixture {
    uint64 internal constant SELECTOR = 2183018362218727504; // Monad testnet
    uint64 internal constant T = NOW + 25 hours;
    uint32 internal constant VOID_SECS = 26 hours;
    uint256 internal constant OI = 100_000;
    string internal constant URI = "ipfs://bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi";

    MockUSDC internal token;
    SeamFactory internal factory;
    MockAssertionVenue internal mvenue;
    BondTreasury internal treasury;
    ResolutionOracle internal ro;
    MarketRegistry internal reg;

    address internal guardian = makeAddr("guardian");
    address internal lister = makeAddr("lister");
    address internal watchdog = makeAddr("watchdog");
    address internal monitor = address(0x30); // RegistryFixture._market().monitor
    address internal attestor;
    uint256 internal attestorKey;
    address[] internal members; // strictly ascending
    uint256[] internal memberKeys;

    function setUp() public {
        vm.chainId(10143);
        vm.warp(NOW);
        token = new MockUSDC();
        usdc = address(token);
        factory = new SeamFactory();
        mvenue = new MockAssertionVenue(usdc, 2e6);
        address me = address(this);
        uint256 n = vm.getNonce(me);
        address treasuryAddr = vm.computeCreateAddress(me, n);
        address oracleAddr = vm.computeCreateAddress(me, n + 1);
        address registryAddr = vm.computeCreateAddress(me, n + 2);
        treasury = new BondTreasury(usdc, oracleAddr, registryAddr, gov);
        ro = new ResolutionOracle(registryAddr, treasuryAddr, usdc, SELECTOR, gov, guardian);
        reg = new MarketRegistry(oracleAddr, treasuryAddr, address(factory), usdc, gov, lister);
        require(address(treasury) == treasuryAddr && address(ro) == oracleAddr && address(reg) == registryAddr);
        factory.setRegistry(address(reg));

        (attestor, attestorKey) = makeAddrAndKey("attestor");
        string[3] memory names = ["member-a", "member-b", "member-c"];
        for (uint256 i; i < 3; ++i) {
            (address a, uint256 k) = makeAddrAndKey(names[i]);
            members.push(a);
            memberKeys.push(k);
        }
        for (uint256 i; i < 3; ++i) {
            for (uint256 j = i + 1; j < 3; ++j) {
                if (members[j] < members[i]) {
                    (members[i], members[j]) = (members[j], members[i]);
                    (memberKeys[i], memberKeys[j]) = (memberKeys[j], memberKeys[i]);
                }
            }
        }
        TrustSetInput memory t;
        t.forwarder = makeAddr("mock forwarder");
        t.runnerAttestor = attestor;
        t.committee = members;
        t.threshold = 2;
        t.watchdog = watchdog;
        t.venue = address(mvenue);
        vm.startPrank(gov);
        ro.createTrustSet(t);
        ro.activateTrustSet(1);
        reg.setGlobals(_globals());
        reg.setProvider(HOST, true);
        reg.setProvider(OTHER, true);
        treasury.setLimits(100e6, 20);
        vm.stopPrank();

        token.mint(me, 10_000e6);
        token.approve(address(treasury), type(uint256).max);
        treasury.deposit(Ledger.ASSERTION, 1_000e6);
    }

    // ------------------------------------------------------------------ the four seam behaviours

    /// An early YES (committee, before T) halts the real engine at block time, is asserted, settles the
    /// engine YES, and claims open through the engine's jobs before T.
    function test_earlyYesClaimableBeforeT() public {
        (bytes32 id, EngineHarness e) = _list(true);
        vm.warp(NOW + 2 hours);
        _toEarlyReview(id, e);
        vm.warp(NOW + 2 hours + 60);
        _proposeEarly(id, Outcome.YES);
        Resolution memory r = ro.getResolution(id);
        HaltView memory hv = e.getHaltSnapshot();
        assertEq(r.haltedAt, NOW + 2 hours + 60, "the early halt is this block");
        assertEq(hv.economicHaltAt, r.haltedAt, "the engine halted at the same time");
        assertEq(r.oiHaltLots, hv.oiHaltLots);
        assertEq(r.oiHaltLots, OI, "the engine's frozen OI");
        assertEq(uint8(r.path), uint8(Path.REVIEWED));

        _assertAndSettleTrue(id);
        assertEq(uint8(ro.getResolution(id).state), uint8(RState.Final));
        assertEq(uint8(ro.getResolution(id).outcome), uint8(Outcome.YES));
        assertEq(uint8(e.finalOutcome()), uint8(MathTypes.FinalOutcome.YES), "settle(1) is YES at the engine");
        assertEq(e.getSettlementStatus().settlementPriceE18, 1e18);

        _openClaims(e);
        assertEq(uint8(e.claimsStatus()), uint8(LifecycleMath.ClaimsStatus.CLAIMABLE));
        assertTrue(e.getSettlementStatus().claimsEnabled);
        assertLt(block.timestamp, T, "claimable before T");
    }

    /// An early INVALID settles the engine INVALID before T, but payouts wait for the INVALID price,
    /// which the engine captures only from T (here the disclosed fallback, at T + grace, no index data).
    function test_earlyInvalidPendingUntilTCapture() public {
        (bytes32 id, EngineHarness e) = _list(false);
        vm.warp(NOW + 2 hours);
        _toEarlyReview(id, e);
        _proposeEarly(id, Outcome.INVALID);
        _assertAndSettleTrue(id);
        assertEq(uint8(ro.getResolution(id).state), uint8(RState.Final));
        assertEq(uint8(e.finalOutcome()), uint8(MathTypes.FinalOutcome.INVALID));
        assertEq(uint8(e.claimsStatus()), uint8(LifecycleMath.ClaimsStatus.ORACLE_FINAL_PRICE_PENDING));

        e.prepareSnapshotChunk(32); // the snapshot may run before the price
        vm.expectRevert(SettlementController.OutcomeOrPricePending.selector);
        e.preparePayoutChunk(32);
        (LifecycleMath.InvalidReadiness s, bool captured) = e.captureInvalidPrice();
        assertEq(uint8(s), uint8(LifecycleMath.InvalidReadiness.NOT_YET), "before T");
        assertFalse(captured);

        vm.warp(T);
        (s, captured) = e.captureInvalidPrice();
        assertEq(uint8(s), uint8(LifecycleMath.InvalidReadiness.WAIT_GRACE), "at T, no index window");
        assertFalse(captured);
        assertEq(uint8(e.claimsStatus()), uint8(LifecycleMath.ClaimsStatus.ORACLE_FINAL_PRICE_PENDING));

        vm.warp(T + 1 hours);
        (s, captured) = e.captureInvalidPrice();
        assertEq(uint8(s), uint8(LifecycleMath.InvalidReadiness.CAPTURE_FALLBACK));
        assertTrue(captured);
        assertEq(e.getSettlementStatus().settlementPriceE18, 5e17, "the disclosed fallback");
        e.preparePayoutChunk(32);
        assertTrue(e.finishPreparation());
        assertEq(uint8(e.claimsStatus()), uint8(LifecycleMath.ClaimsStatus.CLAIMABLE));
    }

    /// A scheduled halt run late still halts the engine at T: the oracle copies `economicHaltAt = T` and
    /// sets `voidDeadline = T + voidSecs`; the engine records when the halt actually happened.
    function test_lateScheduledHaltIsAtT() public {
        (bytes32 id, EngineHarness e) = _list(true);
        vm.warp(T + 2 hours); // the keeper is two hours late
        assertTrue(ro.haltScheduled(id));
        Resolution memory r = ro.getResolution(id);
        HaltView memory hv = e.getHaltSnapshot();
        assertEq(r.haltedAt, T, "haltedAt = T");
        assertEq(hv.economicHaltAt, T, "the engine's economic halt is T");
        assertEq(hv.haltRecordedAt, T + 2 hours, "recorded when it ran");
        assertEq(r.voidDeadline, T + VOID_SECS, "max(haltedAt, T) + voidSecs");
        assertEq(r.oiHaltLots, hv.oiHaltLots);
        assertEq(uint8(r.state), uint8(RState.L1Pending));
        assertFalse(ro.haltScheduled(id), "once");
    }

    /// The engine already holds a different outcome: the oracle's Final transition reverts with the
    /// engine's `ConflictingFinalOutcome`, so the whole transaction rolls back and the oracle does not
    /// become Final (S-02). The same outcome already latched is accepted (idempotent).
    function test_conflictingDeliveryRevertsTheOracle() public {
        (bytes32 id, EngineHarness e) = _list(false);
        _toReviewAtT(id);
        _propose(id, Outcome.NO);
        assertTrue(ro.assertProposal(id));
        bytes32 aid = ro.getResolution(id).assertionId;
        uint256 snap = vm.snapshotState();
        {
            // test_seam_conflictRollsBack
            mvenue.setResult(aid, true);
            vm.prank(address(ro));
            e.settle(1); // a YES already latched at the engine
            uint256 ledgerBefore = treasury.balanceOf(Ledger.ASSERTION);
            vm.expectRevert(LifecycleMath.ConflictingFinalOutcome.selector);
            ro.finalizeMarket(id);
            Resolution memory r = ro.getResolution(id);
            assertEq(uint8(r.state), uint8(RState.Proposed), "not Final");
            assertEq(r.assertionId, aid, "the assertion is still live");
            assertFalse(mvenue.statusOf(aid).settled, "the venue settlement rolled back too");
            assertEq(treasury.balanceOf(Ledger.ASSERTION), ledgerBefore, "no bond booked");
            assertEq(uint8(e.finalOutcome()), uint8(MathTypes.FinalOutcome.YES), "the engine keeps its outcome");
        }
        vm.revertToState(snap);
        {
            // test_seam_voidConflictRollsBack (the venue never answers: the void delivers INVALID)
            vm.prank(address(ro));
            e.settle(1);
            vm.warp(ro.getResolution(id).voidDeadline);
            vm.expectRevert(LifecycleMath.ConflictingFinalOutcome.selector);
            ro.voidMarket(id);
            Resolution memory r = ro.getResolution(id);
            assertEq(uint8(r.state), uint8(RState.Proposed), "not Final");
            assertFalse(r.voided);
        }
        vm.revertToState(snap);
        {
            // test_seam_sameOutcomeIsIdempotent
            mvenue.setResult(aid, true);
            vm.prank(address(ro));
            e.settle(0); // NO already latched
            ro.finalizeMarket(id);
            assertEq(uint8(ro.getResolution(id).state), uint8(RState.Final));
            assertEq(uint8(e.finalOutcome()), uint8(MathTypes.FinalOutcome.NO));
        }
    }

    /// Only the pinned oracle can halt early or settle B's engine; the registry's handshake bound it.
    function test_engineTrustsOnlyTheOracle() public {
        (bytes32 id, EngineHarness e) = _list(true);
        assertEq(e.listing().resolutionAuthority, address(ro));
        assertEq(e.listing().scheduledT, T);
        assertEq(reg.getMarketCore(id).engine, address(e));
        address stranger = makeAddr("stranger");
        bytes memory unauthorized = abi.encodeWithSignature("RiskUnauthorized()"); // RiskContextPort
        vm.startPrank(stranger);
        vm.expectRevert(unauthorized);
        e.halt();
        vm.expectRevert(unauthorized);
        e.settle(1);
        vm.expectRevert(unauthorized);
        e.settleInvalid();
        vm.stopPrank();
        assertFalse(e.getHaltSnapshot().halted);
    }

    // ------------------------------------------------------------------ flows

    /// Lists a market (feed or not) through the real registry and scripts B's accounting mock.
    function _list(bool feed) internal returns (bytes32 id, EngineHarness e) {
        MarketInput memory m = feed ? _market() : _noFeed();
        m.marketId = keccak256(abi.encode("seam-market", feed));
        m.tau = T;
        m.windowStart = NOW;
        m.windowEnd = T;
        m.voidSecs = VOID_SECS;
        id = m.marketId;
        vm.prank(lister);
        e = EngineHarness(reg.createMarket(m, SeamFixture.pack(usdc, gov), ""));
        for (uint32 t = 1; t <= 3; ++t) {
            e.mockSetAccount(t, 1e24, 0);
        }
        e.mockScriptFreeze(IAccountingPort.FreezeResult(0, 0, OI, 0, 3, 0, keccak256("tariff"), keccak256("state")));
        e.mockScriptFinish(IAccountingPort.FinishResult(true, false, 1_220_000_000, 480_000_000));
    }

    /// The monitor restricts the engine and requests the early check; a confident unanimous YES panel
    /// sends the market to EarlyReview.
    function _toEarlyReview(bytes32 id, EngineHarness e) internal {
        vm.startPrank(monitor);
        e.requestReduceOnly(keccak256("early"));
        ro.requestEarlyCheck(id);
        vm.stopPrank();
        PanelResult memory p = _panel(id, Phase.EARLY, uint8(PanelLabel.YES));
        assertEq(uint8(ro.submitPanelResult(id, p, URI, _sign(attestorKey, ro.hashPanelResult(p)))), 2);
    }

    /// Halted at T, the panel finds no validated category: Review.
    function _toReviewAtT(bytes32 id) internal {
        vm.warp(T);
        assertTrue(ro.haltScheduled(id));
        PanelResult memory p = _panel(id, Phase.POST_T, uint8(PanelLabel.NO));
        ro.submitPanelResult(id, p, URI, _sign(attestorKey, ro.hashPanelResult(p)));
        assertEq(uint8(ro.getResolution(id).state), uint8(RState.Review));
    }

    function _proposeEarly(bytes32 id, Outcome o) internal {
        ReviewedProposal memory p = _reviewed(id, o);
        assertTrue(p.early);
        ro.submitReviewedProposal(id, p, URI, _sigs(p));
    }

    function _propose(bytes32 id, Outcome o) internal {
        ReviewedProposal memory p = _reviewed(id, o);
        ro.submitReviewedProposal(id, p, URI, _sigs(p));
    }

    /// Asserts the recorded proposal, the venue settles it true, and `finalizeMarket` applies it.
    function _assertAndSettleTrue(bytes32 id) internal {
        assertTrue(ro.assertProposal(id));
        mvenue.setResult(ro.getResolution(id).assertionId, true);
        vm.warp(block.timestamp + 300); // the reviewed liveness
        ro.finalizeMarket(id);
    }

    /// The engine's permissionless settlement jobs: snapshot, payout, finish.
    function _openClaims(EngineHarness e) internal {
        e.prepareSnapshotChunk(32);
        e.preparePayoutChunk(32);
        assertTrue(e.finishPreparation());
    }

    // ------------------------------------------------------------------ payloads

    function _panel(bytes32 id, Phase phase, uint8 label) internal view returns (PanelResult memory p) {
        Resolution memory r = ro.getResolution(id);
        p.marketId = id;
        p.phase = uint8(phase);
        p.attempt = r.attempts;
        p.labels = [label, label, label];
        p.calibratedBps = [uint16(9_500), uint16(9_500), uint16(9_500)];
        p.evidenceHash = keccak256("snapshot");
        p.evidenceURIHash = keccak256(bytes(URI));
        p.gateHash = reg.getMarketCore(id).gateHash;
        p.trustSetId = r.trustSetId != 0 ? r.trustSetId : ro.activeTrustSetId();
        p.deadline = uint64(block.timestamp + 1 hours);
    }

    function _reviewed(bytes32 id, Outcome o) internal view returns (ReviewedProposal memory p) {
        Resolution memory r = ro.getResolution(id);
        p.marketId = id;
        p.outcome = uint8(o);
        p.evidenceHash = keccak256("snapshot");
        p.evidenceURIHash = keccak256(bytes(URI));
        p.noteHash = keccak256("note");
        p.attempt = r.attempts;
        p.rejectedMask = r.rejectedMask;
        p.early = r.state == RState.EarlyReview;
        p.trustSetId = r.trustSetId != 0 ? r.trustSetId : ro.activeTrustSetId();
        p.deadline = uint64(block.timestamp + 1 hours);
    }

    function _sigs(ReviewedProposal memory p) internal view returns (Sig[] memory s) {
        bytes32 d = ro.hashReviewedProposal(p);
        s = new Sig[](2);
        s[0] = Sig(members[0], _sign(memberKeys[0], d));
        s[1] = Sig(members[1], _sign(memberKeys[1], d));
    }

    function _sign(uint256 key, bytes32 digest) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, digest);
        return abi.encodePacked(r, s, v);
    }
}
