// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {MockUSDC} from "@eros-test/mocks/A/MockUSDC.sol";
import {IMarketConfig} from "@eros/interfaces/IMarketConfig.sol";
import {
    Globals,
    Ledger,
    MarketInput,
    FinalizeStatus,
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
import {ResolutionOracle} from "../../src/ResolutionOracle.sol";
import {MarketRegistry} from "../../src/MarketRegistry.sol";
import {BondTreasury} from "../../src/BondTreasury.sol";
import {RegistryFixture} from "../unit/RegistryFixture.sol";
import {IAssertionVenue} from "../../src/interfaces/IAssertionVenue.sol";
import {MockAssertionVenue} from "../mocks/MockAssertionVenue.sol";
import {MockKeystoneForwarderLite} from "../mocks/MockKeystoneForwarderLite.sol";
import {MockMarketFactory} from "../mocks/MockMarketFactory.sol";
import {MockResolutionEngine} from "../mocks/MockResolutionEngine.sol";

/// @title OracleHandler
/// @notice Stateful fuzz handler for the oracle invariants (plan §5.5, §11.1; task O17.1). Every action
///         drives the real `ResolutionOracle`, `MarketRegistry` and `BondTreasury` with bounded random
///         inputs: listings, time warps, the keeper lifecycle, Layer 1 reports through the header-faithful
///         forwarder or the sim path, signed panel results and committee proposals, permissionless
///         proposals, venue outcomes (true, false, disputed, settled directly, never answered), treasury
///         flows, governance and guardian calls, engine knobs, and unauthorized callers.
/// @dev Inputs are shaped to be mostly valid for the market's current state, so the run reaches every
///      state; some are invalid on purpose. Every call into the system is wrapped in try/catch, so the
///      handler itself never reverts: `calls`, `reverts` and `noops` per action show where the run spends
///      its calls. After every action `_observe` walks every market and records ghost facts for the
///      invariants: violations are latched as flags (`flagsOf`, `globalFlags`), never reverted, so
///      the invariant reports them with the market and the rule.
contract OracleHandler is RegistryFixture {
    // ------------------------------------------------------------------ actions

    enum Action {
        CREATE,
        WARP,
        HALT,
        REQUEST,
        ESCALATE,
        EARLY_CHECK,
        EXPIRE_EARLY,
        OPEN,
        REPORT,
        PANEL,
        COMMITTEE,
        PERMISSIONLESS,
        ASSERT,
        SYNC,
        FINALIZE,
        VOID,
        HEARTBEAT,
        VENUE,
        DISPUTE,
        CLOSE_DISPUTE,
        TREASURY,
        CATEGORY,
        GLOBALS,
        REGISTRY_GOV,
        ORACLE_GOV,
        GUARDIAN,
        ENGINE,
        INTRUDER,
        KEEPER_TICK,
        POKE_FINAL
    }

    // RState bits for `_pickWhere`.
    uint256 internal constant S_NONE = 1 << uint256(RState.None);
    uint256 internal constant S_EARLY_CHECK = 1 << uint256(RState.EarlyCheck);
    uint256 internal constant S_EARLY_REVIEW = 1 << uint256(RState.EarlyReview);
    uint256 internal constant S_L1 = 1 << uint256(RState.L1Pending);
    uint256 internal constant S_L2 = 1 << uint256(RState.L2Pending);
    uint256 internal constant S_REVIEW = 1 << uint256(RState.Review);
    uint256 internal constant S_OPEN = 1 << uint256(RState.Open);
    uint256 internal constant S_PROPOSED = 1 << uint256(RState.Proposed);
    uint256 internal constant S_DISPUTED = 1 << uint256(RState.Disputed);
    uint256 internal constant S_NOT_FINAL = (1 << uint256(RState.Final)) - 1;

    /// @dev Ghost rule flags, one bit per invariant (bit n = ORC-n).
    struct Ghost {
        bytes32 registryHash; // ORC-1: every registry view of the market at listing
        uint8 mask; // last rejectedMask seen
        uint64 voidDeadline; // first non-zero voidDeadline seen
        uint32 trustSetId; // first non-zero trustSetId seen
        bytes32 finalHash; // the Resolution when first seen Final
        Outcome proposed; // last proposal seen
        bytes32 assertionId; // last live assertion seen
        RState state; // last state seen
        uint16 flags; // latched violations, bit n = ORC-n
    }

    // ------------------------------------------------------------------ system

    MockUSDC public token;
    MockMarketFactory public factory;
    BondTreasury public treasury;
    ResolutionOracle public ro;
    MarketRegistry public reg;
    MockKeystoneForwarderLite public keystone;

    uint64 internal constant SELECTOR = 2183018362218727504; // Monad testnet chain selector
    uint256 internal constant MAX_MARKETS = 16;
    uint256 internal constant MAX_LIVE = 4; // markets not yet Final at once: calls concentrate on them
    uint256 internal constant OI_CAP = 2_000_000; // lots: above the 1,668,000-lot review limit
    bytes32 internal constant SPORTS = keccak256("sports");
    bytes32 public constant GROUP = keccak256("handler-group");
    bytes32 public constant WF = keccak256("eros-resolution-workflow");
    address public constant ORG = address(0x0C4E);
    string internal constant URI = "ipfs://bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi";

    address public guardian = makeAddr("guardian");
    address public lister = makeAddr("lister");
    address public watchdog = makeAddr("watchdog");
    address public monitor = address(0x30); // RegistryFixture._market().monitor
    address public simForwarder = makeAddr("sim forwarder");
    address public relayer = makeAddr("sim relayer");
    address public attestor;
    uint256 internal attestorKey;
    address[] public members; // strictly ascending
    uint256[] internal memberKeys;
    address[] public proposers;

    // ------------------------------------------------------------------ markets and ghosts

    bytes32[] public markets;
    mapping(bytes32 id => MockResolutionEngine) public engineOf;
    mapping(bytes32 id => Ghost) public ghost;
    mapping(bytes32 id => bytes32[]) internal _assertions; // every assertion the oracle opened
    bytes32[] public allAssertions;
    uint256 public marketCount;

    bool public productionLocked;
    uint16 public globalFlags; // bit 10 ORC-10 outflow, bit 0 an unauthorized call succeeded
    mapping(uint256 action => uint256) public calls;
    mapping(uint256 action => uint256) public reverts;
    mapping(uint256 action => uint256) public noops;
    mapping(uint256 action => mapping(bytes4 error => uint256)) public revertsBy; // diagnostics
    bytes4[] public errorsSeen;
    mapping(bytes4 => bool) internal _errorSeen;
    mapping(uint256 state => uint256) public stateReached; // entries into each RState
    mapping(uint256 reason => uint256) public finalReasonReached; // Final markets per FinalReason
    uint256 public rejections; // outcomes added to a rejectedMask
    uint256 public l1Proposals; // proposals recorded from a Layer 1 report
    uint256 public locks; // successful lockProduction calls

    constructor() {
        token = new MockUSDC();
        usdc = address(token);
        factory = new MockMarketFactory();
        venue = new MockAssertionVenue(usdc, 2e6);
        keystone = new MockKeystoneForwarderLite();
        address me = address(this);
        uint256 n = vm.getNonce(me);
        address treasuryAddr = vm.computeCreateAddress(me, n);
        address oracleAddr = vm.computeCreateAddress(me, n + 1);
        address registryAddr = vm.computeCreateAddress(me, n + 2);
        treasury = new BondTreasury(usdc, oracleAddr, registryAddr, gov);
        ro = new ResolutionOracle(registryAddr, treasuryAddr, usdc, SELECTOR, gov, guardian);
        reg = new MarketRegistry(oracleAddr, treasuryAddr, address(factory), usdc, gov, lister);
        require(address(treasury) == treasuryAddr && address(ro) == oracleAddr && address(reg) == registryAddr);

        (attestor, attestorKey) = makeAddrAndKey("attestor");
        _makeCommittee();
        for (uint256 i; i < 3; ++i) {
            address p = makeAddr(string.concat("proposer-", vm.toString(i)));
            proposers.push(p);
            token.mint(p, 1e15);
            vm.prank(p);
            token.approve(address(venue), type(uint256).max);
        }

        vm.startPrank(gov);
        ro.createTrustSet(_simSet()); // set 1: the sim-mode set
        ro.createTrustSet(_productionSet()); // set 2: production (KeystoneForwarder, workflow, owner)
        ro.activateTrustSet(1);
        ro.setSimForwarder(simForwarder);
        ro.setSimRelayer(relayer, true);
        reg.setGlobals(_globals());
        reg.setProvider(HOST, true);
        reg.setProvider(OTHER, true);
        treasury.setLimits(1e15, 20);
        vm.stopPrank();

        token.mint(me, 1e15);
        token.approve(address(treasury), type(uint256).max);
        treasury.deposit(Ledger.ASSERTION, 1e12);
        treasury.deposit(Ledger.WATCHDOG_FLOAT, 1e11);
        treasury.deposit(Ledger.PROPOSER_REWARD, 1e9);
    }

    modifier act(Action a) {
        uint256[3] memory before = _ledgers();
        ++calls[uint256(a)];
        _;
        _checkOutflows(a, before);
        _observe();
    }

    // ------------------------------------------------------------------ listing and time

    /// Lists a market (with or without a feed; a third of them in the exclusive group) T 10-60 minutes
    /// ahead.
    function createMarket(uint256 seed) external act(Action.CREATE) {
        if (marketCount >= MAX_MARKETS || _live() >= MAX_LIVE) return _noop(Action.CREATE);
        MarketInput memory m = seed % 3 == 0 ? _noFeed() : _market();
        m.marketId = keccak256(abi.encode("handler-market", marketCount));
        uint64 nowTs = uint64(block.timestamp);
        m.tau = nowTs + uint64(bound(seed >> 8, 600, 3_600));
        m.windowStart = nowTs;
        m.windowEnd = m.tau;
        m.oiCapLots = OI_CAP;
        if ((seed >> 32) % 3 == 0) (m.groupId, m.groupExclusive) = (GROUP, true);
        uint256 oi = bound(seed >> 64, 1, OI_CAP);
        vm.prank(lister);
        try reg.createMarket(m, _pack(), abi.encode(oi)) returns (address engine) {
            markets.push(m.marketId);
            ++marketCount;
            engineOf[m.marketId] = MockResolutionEngine(engine);
            ghost[m.marketId].registryHash = registryHash(m.marketId);
        } catch (bytes memory err) {
            _reverted(Action.CREATE, err);
        }
    }

    /// Moves time forward: mostly up to five minutes (liveness, retry windows), one call in four up to an
    /// hour (past T, the L2 deadline, and after a few, voidDeadline).
    function warp(uint256 seed) external act(Action.WARP) {
        uint256 secs = seed % 4 == 0 ? bound(seed >> 8, 300, 1 hours) : bound(seed >> 8, 1, 300);
        vm.warp(block.timestamp + secs);
    }

    // ------------------------------------------------------------------ keepers (permissionless)

    function _haltScheduled(uint256 m) internal act(Action.HALT) {
        bytes32 id = _pickDue(m);
        if (id == 0) return _noop(Action.HALT);
        try ro.haltScheduled(id) returns (bool changed) {
            if (!changed) _noop(Action.HALT);
        } catch (bytes memory err) {
            _reverted(Action.HALT, err);
        }
    }

    function _requestResolution(uint256 m) internal act(Action.REQUEST) {
        bytes32 id = _pickWhere(m, S_L1);
        if (id == 0) return _noop(Action.REQUEST);
        try ro.requestResolution(id) returns (bool emitted) {
            if (!emitted) _noop(Action.REQUEST);
        } catch (bytes memory err) {
            _reverted(Action.REQUEST, err);
        }
    }

    function _escalateToL2(uint256 m) internal act(Action.ESCALATE) {
        bytes32 id = _pickWhere(m, S_L1);
        if (id == 0) return _noop(Action.ESCALATE);
        try ro.escalateToL2(id) returns (bool changed) {
            if (!changed) _noop(Action.ESCALATE);
        } catch (bytes memory err) {
            _reverted(Action.ESCALATE, err);
        }
    }

    /// The market's monitor restricts the engine and requests the early check (before T). Only one call
    /// in four acts: an early check takes a feed market off the Layer 1 path, which needs its share.
    function requestEarlyCheck(uint256 m) external act(Action.EARLY_CHECK) {
        bytes32 id = (m >> 64) % 4 == 0 ? _pickWhere(m, S_NONE) : bytes32(0);
        if (id == 0) return _noop(Action.EARLY_CHECK);
        vm.startPrank(monitor);
        try engineOf[id].setMonitorRestricted(true) {} catch {}
        try ro.requestEarlyCheck(id) {}
        catch (bytes memory err) {
            _reverted(Action.EARLY_CHECK, err);
        }
        vm.stopPrank();
    }

    function _expireEarly(uint256 m) internal act(Action.EXPIRE_EARLY) {
        bytes32 id = _pickWhere(m, S_EARLY_CHECK | S_EARLY_REVIEW);
        if (id == 0) return _noop(Action.EXPIRE_EARLY);
        try ro.expireEarly(id) returns (bool changed) {
            if (!changed) _noop(Action.EXPIRE_EARLY);
        } catch (bytes memory err) {
            _reverted(Action.EXPIRE_EARLY, err);
        }
    }

    function _openAfterDeadline(uint256 m) internal act(Action.OPEN) {
        bytes32 id = _pickWhere(m, S_L2 | S_REVIEW);
        if (id == 0) return _noop(Action.OPEN);
        try ro.openAfterDeadline(id) returns (bool changed) {
            if (!changed) _noop(Action.OPEN);
        } catch (bytes memory err) {
            _reverted(Action.OPEN, err);
        }
    }

    function _assertProposal(uint256 m) internal act(Action.ASSERT) {
        bytes32 id = _pickRetry(m, S_PROPOSED);
        if (id == 0) return _noop(Action.ASSERT);
        try ro.assertProposal(id) returns (bool asserted) {
            if (!asserted) _noop(Action.ASSERT);
        } catch (bytes memory err) {
            _reverted(Action.ASSERT, err);
        }
    }

    function _syncAssertion(uint256 m) internal act(Action.SYNC) {
        bytes32 id = _pickAsserted(m);
        if (id == 0) return _noop(Action.SYNC);
        try ro.syncAssertion(id) returns (bool changed) {
            if (!changed) _noop(Action.SYNC);
        } catch (bytes memory err) {
            _reverted(Action.SYNC, err);
        }
    }

    function _finalizeMarket(uint256 m) internal act(Action.FINALIZE) {
        bytes32 id = _pickWhere(m, S_PROPOSED | S_DISPUTED);
        if (id == 0) return _noop(Action.FINALIZE);
        try ro.finalizeMarket(id) returns (FinalizeStatus st) {
            if (st == FinalizeStatus.NOT_READY) _noop(Action.FINALIZE);
        } catch (bytes memory err) {
            _reverted(Action.FINALIZE, err);
        }
    }

    function _voidMarket(uint256 m) internal act(Action.VOID) {
        bytes32 id = _pickWhere(m, S_NOT_FINAL & ~S_NONE);
        if (id == 0) return _noop(Action.VOID);
        try ro.voidMarket(id) returns (bool changed) {
            if (!changed) _noop(Action.VOID);
        } catch (bytes memory err) {
            _reverted(Action.VOID, err);
        }
    }

    function watchdogHeartbeat(uint256 seed) external act(Action.HEARTBEAT) {
        vm.prank(seed % 8 == 0 ? proposers[0] : watchdog); // sometimes not a watchdog
        try ro.watchdogHeartbeat() {}
        catch (bytes memory err) {
            _reverted(Action.HEARTBEAT, err);
        }
    }

    // ------------------------------------------------------------------ Layer 1 reports

    /// A report v1 for the market: through the KeystoneForwarder with the production metadata, or from
    /// the sim forwarder with a relayer `tx.origin`; mostly well-formed, sometimes with a bad field.
    function report(uint256 m, uint256 seed) external act(Action.REPORT) {
        bytes32 id = _pickWhere(m, S_L1);
        if (id == 0) return _noop(Action.REPORT);
        Resolution memory r = ro.getResolution(id);
        uint64 tau = reg.getMarketCore(id).tau;
        uint64 earliest = tau + reg.getFeedSpec(id).bufferSecs;
        // The workflow observes from T + bufferSecs: it waits until then, except one report in eight.
        if (block.timestamp < earliest && (seed >> 12) % 8 != 0) vm.warp(earliest);
        uint64 observed =
            block.timestamp > earliest ? uint64(bound(seed >> 16, earliest, block.timestamp)) : uint64(block.timestamp);
        uint8 outcome = seed % 16 == 0 ? 3 : uint8(1 + (seed >> 4) % 2); // INVALID is refused
        bytes memory payload =
            abi.encode(uint8(1), SELECTOR, address(ro), id, outcome, observed, keccak256("value"), reg.getSpecHash(id));
        uint32 setId = r.trustSetId != 0 ? r.trustSetId : ro.activeTrustSetId();
        bool production = ro.trustSet(setId).cfg.production;
        if ((seed >> 8) % 8 == 0) production = !production; // the wrong route on purpose
        bool accepted;
        if (production) {
            MockKeystoneForwarderLite.Header memory h;
            h.executionId = keccak256(abi.encode(id, seed, block.timestamp));
            h.workflowId = WF;
            h.workflowOwner = ORG;
            h.reportId = 0x0001;
            try keystone.report(address(ro), keystone.rawReport(h, payload)) returns (bool ok) {
                accepted = ok;
            } catch {}
        } else {
            vm.prank(simForwarder, relayer);
            try ro.onReport("", payload) {
                accepted = true;
            } catch (bytes memory err) {
                return _reverted(Action.REPORT, err);
            }
        }
        if (!accepted) return _reverted(Action.REPORT, abi.encodeWithSignature("ForwarderReportFailed()"));
        // ORC-4: only an L1Pending market accepts a report. ORC-13: none on a sim set after the lock.
        if (r.state != RState.L1Pending) _flag(id, 4);
        if (productionLocked && !ro.trustSet(r.trustSetId).cfg.production) _flag(id, 13);
    }

    // ------------------------------------------------------------------ Layer 2 panel and committee

    /// A panel result for the market's state (EARLY in EarlyCheck, POST_T otherwise), signed by the
    /// attestor: unanimous, split, NOT_YET, ABSTAIN or flagged; sent as a result or as a proposal.
    function submitPanel(uint256 m, uint256 seed) external act(Action.PANEL) {
        bytes32 id = _pickWhere(m, S_EARLY_CHECK | S_L2);
        if (id == 0) return _noop(Action.PANEL);
        Resolution memory r = ro.getResolution(id);
        bool early = r.state == RState.EarlyCheck;
        PanelResult memory p;
        p.marketId = id;
        p.phase = uint8(early ? Phase.EARLY : Phase.POST_T);
        p.attempt = r.attempts;
        p.labels = _labels(seed);
        uint16 c = seed % 8 == 0 ? uint16(bound(seed >> 8, 0, 10_000)) : 9_500;
        p.calibratedBps = [c, c, c];
        p.evidenceHash = keccak256(abi.encode("snapshot", seed));
        p.evidenceURIHash = keccak256(bytes(URI));
        p.gateHash = reg.getMarketCore(id).gateHash;
        p.flags = seed % 16 == 1 ? 1 : 0;
        p.trustSetId = early || r.trustSetId == 0 ? ro.activeTrustSetId() : r.trustSetId;
        p.deadline = uint64(block.timestamp + 1 hours);
        bytes memory sig = _sign(attestorKey, ro.hashPanelResult(p));
        if ((seed >> 20) % 4 != 0) {
            try ro.submitPanelResult(id, p, URI, sig) {}
            catch (bytes memory err) {
                _reverted(Action.PANEL, err);
            }
        } else {
            try ro.submitPanelProposal(id, p, URI, sig) {}
            catch (bytes memory err) {
                _reverted(Action.PANEL, err);
            }
        }
    }

    /// A committee proposal (YES, NO or INVALID) for the market's state, signed by two of the three members.
    function submitReviewedProposal(uint256 m, uint256 seed) external act(Action.COMMITTEE) {
        bytes32 id = _pickRetry(m, S_REVIEW | S_OPEN | S_EARLY_REVIEW);
        if (id == 0) return _noop(Action.COMMITTEE);
        Resolution memory r = ro.getResolution(id);
        bool early = r.state == RState.EarlyReview;
        ReviewedProposal memory p;
        p.marketId = id;
        p.outcome = uint8(_outcome(r.rejectedMask, seed));
        p.evidenceHash = keccak256(abi.encode("snapshot", seed));
        p.evidenceURIHash = keccak256(bytes(URI));
        p.noteHash = keccak256("note");
        p.attempt = r.attempts;
        p.rejectedMask = r.rejectedMask;
        p.early = early;
        p.trustSetId = early || r.trustSetId == 0 ? ro.activeTrustSetId() : r.trustSetId;
        p.deadline = uint64(block.timestamp + 1 hours);
        bytes32 d = ro.hashReviewedProposal(p);
        uint256 skip = (seed >> 8) % 3; // the member who does not sign
        Sig[] memory sigs = new Sig[](2);
        uint256 k;
        for (uint256 i; i < 3; ++i) {
            if (i == skip) continue;
            sigs[k++] = Sig(members[i], _sign(memberKeys[i], d));
        }
        try ro.submitReviewedProposal(id, p, URI, sigs) {}
        catch (bytes memory err) {
            _reverted(Action.COMMITTEE, err);
        }
    }

    /// Anyone with their own bond, in Open.
    function proposePermissionless(uint256 m, uint256 seed) external act(Action.PERMISSIONLESS) {
        bytes32 id = _pickRetry(m, S_OPEN);
        if (id == 0) return _noop(Action.PERMISSIONLESS);
        Outcome o = _outcome(ro.getResolution(id).rejectedMask, seed >> 8);
        vm.prank(proposers[seed % proposers.length]);
        try ro.proposePermissionless(id, o, URI, keccak256(abi.encode("evidence", seed))) {}
        catch (bytes memory err) {
            _reverted(Action.PERMISSIONLESS, err);
        }
    }

    // ------------------------------------------------------------------ venue and disputes

    /// What the venue does with an assertion the oracle opened: settles true or false when asked
    /// (`setResult`), is disputed, is settled directly behind the oracle's back, or never answers; half
    /// the time a keeper then runs `finalizeMarket` on the market at once.
    function venueOutcome(uint256 a, uint256 mode) external act(Action.VENUE) {
        if (allAssertions.length == 0) return _noop(Action.VENUE);
        bytes32 aid = _liveAssertion(a);
        bool steer = (mode >> 8) % 2 == 0;
        bool steerKeeper = (mode >> 9) % 2 == 0;
        mode %= 6;
        // After a first rejection, answer false half the time, so YES and NO both end up rejected
        // (the REJECTED_YES_AND_NO void) within a run.
        if (steer && ro.getResolution(venue.marketOf(aid)).rejectedMask != 0) mode = 1;
        if (mode == 0) {
            venue.setResult(aid, true);
        } else if (mode == 1) {
            venue.setResult(aid, false);
        } else if (mode == 2) {
            venue.markDisputed(aid, makeAddr("disputer"));
        } else if (mode == 5) {
            _noop(Action.VENUE); // never answered
        } else {
            if (venue.statusOf(aid).settled) return _noop(Action.VENUE);
            venue.settleDirectly(aid, mode == 3);
        }
        // Half the time the keeper reacts at once and applies the venue's answer.
        if (steerKeeper) {
            try ro.finalizeMarket(venue.marketOf(aid)) {} catch {}
        }
    }

    /// The pinned watchdog disputes through the treasury's float.
    function disputeViaVenue(uint256 m) external act(Action.DISPUTE) {
        bytes32 id = _pickAsserted(m);
        if (id == 0) return _noop(Action.DISPUTE);
        address w = ro.watchdogOf(id);
        vm.prank(w == address(0) ? watchdog : w);
        try treasury.disputeViaVenue(id) {}
        catch (bytes memory err) {
            _reverted(Action.DISPUTE, err);
        }
    }

    function closeDispute(uint256 a) external act(Action.CLOSE_DISPUTE) {
        if (allAssertions.length == 0) return _noop(Action.CLOSE_DISPUTE);
        try treasury.closeDispute(allAssertions[a % allAssertions.length]) returns (bool closed) {
            if (!closed) _noop(Action.CLOSE_DISPUTE);
        } catch (bytes memory err) {
            _reverted(Action.CLOSE_DISPUTE, err);
        }
    }

    // ------------------------------------------------------------------ treasury

    /// Deposits, a donation (for `skim`), `claimOwed`, `skim`, the Timelock's `withdraw` and `setLimits`.
    function treasuryAction(uint256 seed) external act(Action.TREASURY) {
        uint256 kind = seed % 6;
        uint256 amount = bound(seed >> 8, 1, 1e9);
        // ASSERTION half the time: it is the ledger with a withdrawal floor (ORC-10).
        Ledger ledger = (seed >> 4) % 2 == 0 ? Ledger.ASSERTION : Ledger(uint8(1 + (seed >> 5) % 2));
        if (kind == 0) {
            try treasury.deposit(ledger, amount) {}
            catch (bytes memory err) {
                _reverted(Action.TREASURY, err);
            }
        } else if (kind == 1) {
            require(token.transfer(address(treasury), amount)); // a donation, credited by skim
        } else if (kind == 2) {
            vm.prank(proposers[(seed >> 8) % proposers.length]);
            try treasury.claimOwed() {}
            catch (bytes memory err) {
                _reverted(Action.TREASURY, err);
            }
        } else if (kind == 3) {
            try treasury.skim() {}
            catch (bytes memory err) {
                _reverted(Action.TREASURY, err);
            }
        } else if (kind == 4) {
            // Random, the whole ledger, exactly down to the listing commitments, or one atom past them.
            uint256 have = treasury.balanceOf(ledger);
            uint256 floor_ = ledger == Ledger.ASSERTION ? treasury.totalCommitted() : 0;
            uint256 pick = (seed >> 16) % 4;
            if (pick == 0) amount = bound(seed >> 24, 0, have);
            else if (pick == 1) amount = have;
            else if (have >= floor_) amount = have - floor_ + (pick == 3 ? 1 : 0);
            else amount = 1;
            vm.prank(gov);
            try treasury.withdraw(ledger, gov, amount) {
                // ORC-10: a withdrawal never takes ASSERTION below the listing commitments.
                if (treasury.balanceOf(Ledger.ASSERTION) < treasury.totalCommitted()) globalFlags |= 1 << 10;
                // Operations top the ledger back up, so a drained ledger does not stall the run.
                if (amount != 0) treasury.deposit(ledger, amount);
            } catch (bytes memory err) {
                _reverted(Action.TREASURY, err);
            }
        } else {
            vm.prank(gov);
            try treasury.setLimits(seed % 4 == 0 ? 50e6 : 1e15, uint32(bound(seed >> 8, 1, 20))) {}
            catch (bytes memory err) {
                _reverted(Action.TREASURY, err);
            }
        }
    }

    // ------------------------------------------------------------------ registry governance

    /// Validates, revokes or re-records the sports category, sometimes outside U95/N.
    function _setCategory(uint256 seed) internal act(Action.CATEGORY) {
        bytes32 gate = seed % 8 == 0 ? keccak256("another gate") : _gateHash();
        uint16 u95 = seed % 5 == 0 ? 201 : 200;
        uint32 sampleN = seed % 7 == 0 ? 149 : 150;
        vm.prank(gov);
        try reg.setCategory(SPORTS, gate, u95, sampleN, (seed >> 8) % 4 != 0) {}
        catch (bytes memory err) {
            _reverted(Action.CATEGORY, err);
        }
    }

    /// A new globals version: the review limit, the retry window and the permissionless reward vary.
    function _setGlobals(uint256 seed) internal act(Action.GLOBALS) {
        Globals memory g = _globals();
        g.reviewLimitAtoms = seed % 3 == 0 ? 1e6 : 1_668_000_000;
        g.retryWindowSecs = uint32(bound(seed >> 8, 60, 900));
        g.proposerRewardAtoms = bound(seed >> 24, 0, 5e6);
        vm.prank(gov);
        try reg.setGlobals(g) {}
        catch (bytes memory err) {
            _reverted(Action.GLOBALS, err);
        }
    }

    /// Providers, auth references, and the lister and factory set to their current values.
    function _registryGovernance(uint256 seed) internal act(Action.REGISTRY_GOV) {
        uint256 kind = seed % 4;
        vm.startPrank(gov);
        if (kind == 0) {
            try reg.setProvider("rare.example.org", (seed >> 8) % 2 == 0) {}
            catch (bytes memory err) {
                _reverted(Action.REGISTRY_GOV, err);
            }
        } else if (kind == 1) {
            try reg.setAuthRef(keccak256(abi.encode(seed)), true) {}
            catch (bytes memory err) {
                _reverted(Action.REGISTRY_GOV, err);
            }
        } else if (kind == 2) {
            try reg.setLister(lister) {}
            catch (bytes memory err) {
                _reverted(Action.REGISTRY_GOV, err);
            }
        } else {
            try reg.setFactory(address(factory)) {}
            catch (bytes memory err) {
                _reverted(Action.REGISTRY_GOV, err);
            }
        }
        vm.stopPrank();
    }

    // ------------------------------------------------------------------ oracle governance and guardian

    /// Trust sets (a sim set or a production set), activation, the sim-mode bridge and `lockProduction`
    /// (after activating the production set 2, as the mainnet runbook does).
    function _oracleGovernance(uint256 seed) internal act(Action.ORACLE_GOV) {
        uint256 kind = seed % 5;
        vm.startPrank(gov);
        if (kind == 0) {
            try ro.createTrustSet((seed >> 8) % 2 == 0 ? _simSet() : _productionSet()) {}
            catch (bytes memory err) {
                _reverted(Action.ORACLE_GOV, err);
            }
        } else if (kind == 1) {
            uint32 setId = uint32(1 + (seed >> 8) % ro.trustSetCount());
            try ro.activateTrustSet(setId) {}
            catch (bytes memory err) {
                _reverted(Action.ORACLE_GOV, err);
            }
        } else if (kind == 2) {
            try ro.setSimForwarder((seed >> 8) % 4 == 0 ? address(0) : simForwarder) {}
            catch (bytes memory err) {
                _reverted(Action.ORACLE_GOV, err);
            }
        } else if (kind == 3) {
            try ro.setSimRelayer(relayer, (seed >> 8) % 4 != 0) {}
            catch (bytes memory err) {
                _reverted(Action.ORACLE_GOV, err);
            }
        } else {
            // §12.6: activate the production set, then lock (the activation is skipped once locked).
            if (!ro.trustSet(ro.activeTrustSetId()).cfg.production) {
                try ro.activateTrustSet(2) {}
                catch (bytes memory err) {
                    _reverted(Action.ORACLE_GOV, err);
                }
            }
            try ro.lockProduction() {
                productionLocked = true;
                ++locks;
            } catch (bytes memory err) {
                _reverted(Action.ORACLE_GOV, err);
            }
        }
        vm.stopPrank();
    }

    /// The guardian revokes a workflow ID, the attestor, a committee member or the watchdog of a set.
    function _guardianAction(uint256 seed) internal act(Action.GUARDIAN) {
        if (seed % 4 != 0) return _noop(Action.GUARDIAN); // revocations are permanent: keep them rare
        seed >>= 2;
        uint32 setId = uint32(1 + (seed >> 8) % ro.trustSetCount());
        uint256 kind = seed % 4;
        vm.startPrank(guardian);
        if (kind == 0) {
            try ro.revokeWorkflowId(setId, WF) {}
            catch (bytes memory err) {
                _reverted(Action.GUARDIAN, err);
            }
        } else if (kind == 1) {
            try ro.revokeAttestor(setId) {}
            catch (bytes memory err) {
                _reverted(Action.GUARDIAN, err);
            }
        } else if (kind == 2) {
            try ro.revokeCommitteeMember(setId, members[(seed >> 16) % 3]) {}
            catch (bytes memory err) {
                _reverted(Action.GUARDIAN, err);
            }
        } else {
            try ro.revokeWatchdog(setId) {}
            catch (bytes memory err) {
                _reverted(Action.GUARDIAN, err);
            }
        }
        vm.stopPrank();
    }

    // ------------------------------------------------------------------ engine knobs

    /// The market's OI before the halt, a reverting `settle` (S-02), and the monitor's restriction.
    function _engineKnob(uint256 m, uint256 seed) internal act(Action.ENGINE) {
        bytes32 id = _pick(m);
        if (id == 0) return _noop(Action.ENGINE);
        MockResolutionEngine e = engineOf[id];
        uint256 kind = seed % 3;
        if (kind == 0) {
            e.setOiLots(bound(seed >> 8, 1, OI_CAP));
        } else if (kind == 1) {
            e.setRevertOnSettle((seed >> 8) % 4 == 0); // mostly switched back off
        } else {
            vm.prank(monitor);
            e.setMonitorRestricted((seed >> 8) % 2 == 0);
        }
    }

    // ------------------------------------------------------------------ unauthorized callers

    /// Restricted entry points called by an outsider; any success is latched (bit 0 of `globalFlags`).
    function _intruder(uint256 m, uint256 seed) internal act(Action.INTRUDER) {
        bytes32 id = _pick(m);
        address who = proposers[seed % proposers.length];
        uint256 kind = (seed >> 8) % 12;
        vm.startPrank(who);
        bool ok;
        if (kind == 0) {
            try ro.initResolution(keccak256(abi.encode(seed))) {
                ok = true;
            } catch {}
        } else if (kind == 1) {
            try treasury.commitListing(id, 1) {
                ok = true;
            } catch {}
        } else if (kind == 2) {
            try treasury.releaseListing(id) {
                ok = true;
            } catch {}
        } else if (kind == 3) {
            try treasury.fundAssertion(id, 0, who, 1) {
                ok = true;
            } catch {}
        } else if (kind == 4) {
            try treasury.onBondReturned(id, 0) {
                ok = true;
            } catch {}
        } else if (kind == 5) {
            try treasury.onBondLost(id, 0) {
                ok = true;
            } catch {}
        } else if (kind == 6) {
            try treasury.markStuck(id, 0) {
                ok = true;
            } catch {}
        } else if (kind == 7) {
            try treasury.payProposerReward(id, who, 1) {
                ok = true;
            } catch {}
        } else if (kind == 8) {
            try treasury.withdraw(Ledger.ASSERTION, who, 1) {
                ok = true;
            } catch {}
        } else if (kind == 9) {
            try ro.revokeAttestor(1) {
                ok = true;
            } catch {}
        } else if (kind == 10) {
            try ro.activateTrustSet(1) {
                ok = true;
            } catch {}
        } else {
            try reg.setGlobals(_globals()) {
                ok = true;
            } catch {}
        }
        vm.stopPrank();
        if (ok) globalFlags |= 1; // a refusal is the expected result, not a revert of the run
    }

    // ------------------------------------------------------------------ dispatchers

    /// One keeper function on one market (halt, request, escalate, expireEarly, open, assert, sync,
    /// finalize, void). One selector for the nine keeps the fuzzer's call mix on the lifecycle.
    function keeper(uint256 which, uint256 m) external {
        which %= 9;
        if (which == 0) _haltScheduled(m);
        else if (which == 1) _requestResolution(m);
        else if (which == 2) _escalateToL2(m);
        else if (which == 3) _expireEarly(m);
        else if (which == 4) _openAfterDeadline(m);
        else if (which == 5) _assertProposal(m);
        else if (which == 6) _syncAssertion(m);
        else if (which == 7) _finalizeMarket(m);
        else _voidMarket(m);
    }

    /// One administrative or adversarial action: registry and oracle governance, the guardian, engine
    /// knobs or an unauthorized caller. One selector for them keeps them a small share of the calls
    /// (treasury flows have their own selector: the withdrawal rule of ORC-10 needs the calls).
    function admin(uint256 which, uint256 m, uint256 seed) external {
        which %= 8;
        if (which == 0) _setCategory(seed);
        else if (which == 1) _setCategory(seed >> 1);
        else if (which == 2) _setGlobals(seed);
        else if (which == 3) _registryGovernance(seed);
        else if (which == 4) _oracleGovernance(seed);
        else if (which == 5) _guardianAction(seed);
        else if (which == 6) _engineKnob(m, seed);
        else _intruder(m, seed);
    }

    // ------------------------------------------------------------------ Final markets (ORC-8)

    /// Calls every permissionless entry point on a Final market (half the time after its voidDeadline),
    /// so "nothing changes after Final" is exercised, not only observed.
    function pokeFinal(uint256 m, uint256 seed) external act(Action.POKE_FINAL) {
        bytes32 id = _pickWhere(m, 1 << uint256(RState.Final));
        if (id == 0 || ro.getResolution(id).state != RState.Final) return _noop(Action.POKE_FINAL);
        uint64 deadline = ro.getResolution(id).voidDeadline;
        if (seed % 2 == 0 && block.timestamp < deadline) vm.warp(deadline);
        address who = proposers[seed % proposers.length];
        vm.startPrank(who);
        try ro.haltScheduled(id) {} catch {}
        try ro.requestResolution(id) {} catch {}
        try ro.escalateToL2(id) {} catch {}
        try ro.expireEarly(id) {} catch {}
        try ro.openAfterDeadline(id) {} catch {}
        try ro.assertProposal(id) {} catch {}
        try ro.syncAssertion(id) {} catch {}
        try ro.finalizeMarket(id) {} catch {}
        try ro.voidMarket(id) {} catch {}
        try ro.proposePermissionless(id, Outcome(1 + (seed >> 8) % 3), URI, keccak256("late")) {} catch {}
        vm.stopPrank();
    }

    // ------------------------------------------------------------------ keeper bot

    /// One keeper tick on a market: every keeper function in lifecycle order, as the keeper bot runs them
    /// (each returns false or NOT_READY when it has nothing to do). Counts as acted when the state moved.
    function keeperTick(uint256 m) external act(Action.KEEPER_TICK) {
        bytes32 id = _pickWhere(m, S_NOT_FINAL);
        if (id == 0) return _noop(Action.KEEPER_TICK);
        RState before = ro.getResolution(id).state;
        try ro.haltScheduled(id) {} catch {}
        if (reg.getMarketCore(id).hasFeed) {
            try ro.requestResolution(id) {} catch {}
            try ro.escalateToL2(id) {} catch {}
        }
        try ro.expireEarly(id) {} catch {}
        try ro.openAfterDeadline(id) {} catch {}
        try ro.assertProposal(id) {} catch {}
        try ro.syncAssertion(id) {} catch {}
        try ro.finalizeMarket(id) {} catch {}
        try ro.voidMarket(id) {} catch {}
        if (ro.getResolution(id).state == before) _noop(Action.KEEPER_TICK);
    }

    // ------------------------------------------------------------------ views for the invariants

    /// The scripted venue every trust set uses (declared by RegistryFixture).
    function assertionVenue() external view returns (MockAssertionVenue) {
        return venue;
    }

    function errorsSeenLength() external view returns (uint256) {
        return errorsSeen.length;
    }

    function marketsLength() external view returns (uint256) {
        return markets.length;
    }

    function assertionsOf(bytes32 id) external view returns (bytes32[] memory) {
        return _assertions[id];
    }

    function flagsOf(bytes32 id) external view returns (uint16) {
        return ghost[id].flags;
    }

    /// Every registry view of a market, hashed (ORC-1).
    function registryHash(bytes32 id) public view returns (bytes32) {
        return keccak256(
            abi.encode(
                reg.getMarketCore(id),
                reg.getFeedSpec(id),
                reg.getSpecHash(id),
                reg.getAllowList(id),
                reg.getAIConfig(id),
                reg.getUMAConfig(id),
                reg.getQuestion(id),
                reg.getRules(id),
                reg.getClaimTemplate(id)
            )
        );
    }

    // ------------------------------------------------------------------ ghost bookkeeping

    /// After every action: the per-market facts the invariants need, latched as flags.
    function _observe() internal {
        uint256 n = markets.length;
        for (uint256 i; i < n; ++i) {
            bytes32 id = markets[i];
            Resolution memory r = ro.getResolution(id);
            Ghost storage g = ghost[id];
            // ORC-6: the mask only grows, and no new proposal is of an outcome rejected before it.
            if (r.rejectedMask & g.mask != g.mask) _flag(id, 6);
            if (r.rejectedMask != g.mask) ++rejections;
            if (r.proposed != Outcome.NONE && r.proposed != g.proposed) {
                if (r.path == Path.L1) ++l1Proposals;
                if (g.mask & (uint8(1) << uint8(r.proposed)) != 0) _flag(id, 6);
                // ORC-15: a proposal recorded before T is a committee one; L2_AUTO never before T.
                if (block.timestamp < reg.getMarketCore(id).tau && r.path != Path.REVIEWED) _flag(id, 15);
            }
            // ORC-5: a new live assertion only replaces none (one at a time).
            if (r.assertionId != 0 && r.assertionId != g.assertionId) {
                if (g.assertionId != 0) _flag(id, 5);
                _assertions[id].push(r.assertionId);
                allAssertions.push(r.assertionId);
            }
            // ORC-12 / ORC-13: voidDeadline and the pinned trust set are set once.
            if (g.voidDeadline != 0 && r.voidDeadline != g.voidDeadline) _flag(id, 12);
            if (g.trustSetId != 0 && r.trustSetId != g.trustSetId) _flag(id, 13);
            // ORC-8: nothing changes after Final.
            bytes32 h = keccak256(abi.encode(r));
            if (r.state == RState.Final) {
                if (g.finalHash == 0) g.finalHash = h;
                else if (h != g.finalHash) _flag(id, 8);
            } else if (g.finalHash != 0) {
                _flag(id, 8);
            }
            // ORC-1: no registry field changes after listing.
            if (registryHash(id) != g.registryHash) _flag(id, 1);
            if (r.state != g.state) {
                ++stateReached[uint256(r.state)];
                if (r.state == RState.Final) ++finalReasonReached[uint256(r.finalReason)];
            }
            g.state = r.state;
            g.mask = r.rejectedMask;
            g.proposed = r.proposed;
            g.assertionId = r.assertionId;
            if (g.voidDeadline == 0) g.voidDeadline = r.voidDeadline;
            if (g.trustSetId == 0) g.trustSetId = r.trustSetId;
        }
    }

    /// ORC-10: a ledger only decreases through its own path, or the Timelock's withdraw (TREASURY, which
    /// also holds claimOwed): ASSERTION through assertProposal, WATCHDOG_FLOAT through disputeViaVenue,
    /// PROPOSER_REWARD through a finalize or a void that pays a permissionless proposer. A keeper tick
    /// runs assertProposal, finalizeMarket and voidMarket, so it may move ASSERTION and PROPOSER_REWARD; a
    /// venue answer may be followed by finalizeMarket, so it may move PROPOSER_REWARD.
    function _checkOutflows(Action a, uint256[3] memory before) internal {
        uint256[3] memory after_ = _ledgers();
        bool treasuryCall = a == Action.TREASURY;
        bool tick = a == Action.KEEPER_TICK;
        if (after_[0] < before[0] && a != Action.ASSERT && !tick && !treasuryCall) globalFlags |= 1 << 10;
        if (after_[1] < before[1] && a != Action.DISPUTE && !treasuryCall) globalFlags |= 1 << 10;
        bool finalizing = a == Action.FINALIZE || a == Action.VOID || a == Action.VENUE || tick;
        if (after_[2] < before[2] && !finalizing && !treasuryCall) {
            globalFlags |= 1 << 10;
        }
    }

    function _ledgers() internal view returns (uint256[3] memory l) {
        l[0] = treasury.balanceOf(Ledger.ASSERTION);
        l[1] = treasury.balanceOf(Ledger.WATCHDOG_FLOAT);
        l[2] = treasury.balanceOf(Ledger.PROPOSER_REWARD);
    }

    function _flag(bytes32 id, uint256 rule) internal {
        ghost[id].flags |= uint16(1 << rule);
    }

    function _reverted(Action a, bytes memory err) internal {
        ++reverts[uint256(a)];
        bytes4 sel = bytes4(err);
        if (!_errorSeen[sel]) {
            _errorSeen[sel] = true;
            errorsSeen.push(sel);
        }
        ++revertsBy[uint256(a)][sel];
    }

    function _noop(Action a) internal {
        ++noops[uint256(a)];
    }

    // ------------------------------------------------------------------ inputs

    function _pick(uint256 m) internal view returns (bytes32) {
        uint256 n = markets.length;
        return n == 0 ? bytes32(0) : markets[m % n];
    }

    /// A market whose state is in `mask`, searched from a random start (0 when none qualifies: the call
    /// is a no-op). One call in eight takes any market instead, so calls in the wrong state still happen.
    function _pickWhere(uint256 m, uint256 mask) internal view returns (bytes32) {
        uint256 n = markets.length;
        if (n == 0 || (m >> 128) % 8 == 0) return _pick(m);
        for (uint256 k; k < n; ++k) {
            bytes32 id = markets[(m % n + k) % n];
            if (mask & (1 << uint256(ro.getResolution(id).state)) != 0) return id;
        }
        return 0;
    }

    /// A market in `mask` that already had an outcome rejected (its retry is the path to the second
    /// rejection and REJECTED_YES_AND_NO), else as `_pickWhere`.
    function _pickRetry(uint256 m, uint256 mask) internal view returns (bytes32) {
        uint256 n = markets.length;
        for (uint256 k; k < n && (m >> 128) % 8 != 0; ++k) {
            Resolution memory r = ro.getResolution(markets[(m % n + k) % n]);
            if (r.rejectedMask != 0 && mask & (1 << uint256(r.state)) != 0) return markets[(m % n + k) % n];
        }
        return _pickWhere(m, mask);
    }

    /// A Proposed market whose assertion is live on the venue (not expired, settled or disputed: what a
    /// dispute or a sync acts on); 0 when there is none. One call in eight takes any market instead.
    function _pickAsserted(uint256 m) internal view returns (bytes32) {
        uint256 n = markets.length;
        for (uint256 k; k < n && (m >> 128) % 8 != 0; ++k) {
            Resolution memory r = ro.getResolution(markets[(m % n + k) % n]);
            if (r.state != RState.Proposed || r.assertionId == 0) continue;
            IAssertionVenue.AssertionStatus memory st = venue.statusOf(r.assertionId);
            if (!st.settled && !st.disputed && st.expiresAt > block.timestamp) return markets[(m % n + k) % n];
        }
        return (m >> 128) % 8 == 0 ? _pick(m) : bytes32(0);
    }

    /// A market in None whose T has passed (the halt can act), else as `_pickWhere(None)`.
    function _pickDue(uint256 m) internal view returns (bytes32) {
        uint256 n = markets.length;
        for (uint256 k; k < n && (m >> 128) % 8 != 0; ++k) {
            bytes32 id = markets[(m % n + k) % n];
            if (ro.getResolution(id).state == RState.None && reg.getMarketCore(id).tau <= block.timestamp) return id;
        }
        return _pickWhere(m, S_NONE);
    }

    function _live() internal view returns (uint256 live) {
        for (uint256 i; i < markets.length; ++i) {
            if (ro.getResolution(markets[i]).state != RState.Final) ++live;
        }
    }

    /// An assertion the oracle is waiting on (its market's live assertion, not settled on the venue),
    /// searched from a random start; else any assertion the oracle opened (stale ones included).
    function _liveAssertion(uint256 a) internal view returns (bytes32) {
        uint256 n = allAssertions.length;
        for (uint256 k; k < n; ++k) {
            bytes32 aid = allAssertions[(a % n + k) % n];
            if (!venue.statusOf(aid).settled && ro.getResolution(venue.marketOf(aid)).assertionId == aid) return aid;
        }
        return allAssertions[a % n];
    }

    /// The outcome of a committee or permissionless proposal. After a rejection, one call in four retries
    /// a rejected outcome (ORC-6 must refuse it) and the others mostly propose the other binary outcome
    /// (the path to REJECTED_YES_AND_NO). Otherwise an outcome not rejected, YES and NO twice as likely as
    /// INVALID; one call in eight any outcome.
    function _outcome(uint8 mask, uint256 seed) internal pure returns (Outcome) {
        Outcome[5] memory order = [Outcome.YES, Outcome.NO, Outcome.YES, Outcome.NO, Outcome.INVALID];
        uint256 start = (seed >> 3) % 5;
        if (mask != 0 && seed % 4 == 0) {
            for (uint8 o = 1; o <= 3; ++o) {
                if (mask & (uint8(1) << o) != 0) return Outcome(o);
            }
        }
        if (mask == 0 && seed % 8 == 0) return order[start];
        bool yesOut = mask & 2 != 0;
        bool noOut = mask & 4 != 0;
        if (yesOut != noOut && (seed >> 1) % 4 != 0) return yesOut ? Outcome.NO : Outcome.YES;
        for (uint256 k; k < 5; ++k) {
            Outcome o = order[(start + k) % 5];
            if (mask & (uint8(1) << uint8(o)) == 0) return o;
        }
        return order[start];
    }

    /// Mostly unanimous (YES, NO or INVALID), sometimes split, NOT_YET or ABSTAIN.
    function _labels(uint256 seed) internal pure returns (uint8[3] memory l) {
        uint256 kind = seed % 10;
        uint8 y = uint8(PanelLabel.YES);
        uint8 no = uint8(PanelLabel.NO);
        if (kind < 3) return [y, y, y];
        if (kind < 6) return [no, no, no];
        if (kind == 6) return [uint8(PanelLabel.INVALID), uint8(PanelLabel.INVALID), uint8(PanelLabel.INVALID)];
        if (kind == 7) return [y, no, y];
        if (kind == 8) return [uint8(PanelLabel.NOT_YET), uint8(PanelLabel.NOT_YET), y];
        return [uint8(PanelLabel.ABSTAIN), y, y];
    }

    function _gateHash() internal pure returns (bytes32) {
        bytes32[3] memory models = [keccak256("a:m1@1"), keccak256("b:m2@1"), keccak256("c:m3@1")];
        return keccak256(abi.encode(models, keccak256("prompt"), keccak256("calibrator"), uint16(9_100)));
    }

    function _sign(uint256 key, bytes32 digest) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, digest);
        return abi.encodePacked(r, s, v);
    }

    function _makeCommittee() internal {
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
    }

    function _simSet() internal view returns (TrustSetInput memory t) {
        t.forwarder = simForwarder;
        t.runnerAttestor = attestor;
        t.committee = members;
        t.threshold = 2;
        t.watchdog = watchdog;
        t.venue = address(venue);
    }

    function _productionSet() internal view returns (TrustSetInput memory t) {
        t = _simSet();
        t.forwarder = address(keystone);
        t.production = true;
        t.workflowIds = [WF, bytes32(0)];
        t.workflowOwner = ORG;
    }

    function _pack() internal view returns (IMarketConfig.Listing memory l) {
        l.token = usdc;
        l.governance = gov;
        l.indexSigner = address(0x51);
        l.deploymentCapX = 1;
        l.maxTraders = 1024;
        l.depthNLots = 500;
        l.minOrderLots = 1;
        l.maxOrderLots = 1e9;
    }
}
