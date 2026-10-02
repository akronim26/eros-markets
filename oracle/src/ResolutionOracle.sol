// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {EIP712} from "solady/utils/EIP712.sol";
import {ReentrancyGuard} from "solady/utils/ReentrancyGuard.sol";
import {IResolutionEngine, HaltView} from "@eros/interfaces/IResolutionIngress.sol";
import {
    Outcome,
    Path,
    RState,
    FinalReason,
    FinalizeStatus,
    Ledger,
    Phase,
    PanelLabel,
    PanelResult,
    AIConfig,
    Category,
    Resolution,
    TrustSet,
    TrustSetInput,
    GroupState,
    MarketCore,
    FeedSpec,
    Globals,
    UMAConfig,
    ReviewedProposal,
    Sig,
    OracleConst
} from "./types/OracleTypes.sol";
import {IResolutionOracle} from "./interfaces/IResolutionOracle.sol";
import {IMarketRegistry} from "./interfaces/IMarketRegistry.sol";
import {IAssertionVenue} from "./interfaces/IAssertionVenue.sol";
import {IBondTreasury} from "./interfaces/IBondTreasury.sol";
import {IEngineMonitorView} from "./interfaces/IEngineMonitorView.sol";
import {BondMath} from "./libraries/BondMath.sol";
import {ClaimRenderer} from "./libraries/ClaimRenderer.sol";
import {HostLib} from "./libraries/HostLib.sol";
import {SigLib} from "./libraries/SigLib.sol";

/// @title ResolutionOracle
/// @notice The per-market resolution state machine (plan §5, §6.4, Appendix C.1, C.3). It is the engine's
///         pinned `resolutionAuthority` and the only contract that can halt or settle a market, so it is
///         not upgradeable and keeps one stable address. There is no pause and no admin path that moves a
///         market (D20): governance only manages trust sets and the sim-mode bridge, the guardian only
///         revokes, and every progress step is permissionless.
/// @dev Tasks O14.1 (constructor, trust sets, guardian revocations, `initResolution`, watchdog
///      heartbeat), O14.2 (halt, request, escalate, open) and O14.3 (committee and permissionless
///      proposals, with the shared assertion internals). Assertions, finalize and void, the panel and
///      groups follow in O14.4-O14.6, the CRE receiver in O15 and the EIP-712 views in O16, which also declares
///      `is IResolutionOracle`. Until then errors and events are the C.3 declarations, used by qualified
///      name.
///
///      Keeper functions (`haltScheduled`, `requestResolution`, `escalateToL2`, `openAfterDeadline`, and
///      later `expireEarly`, `assertProposal`, `syncAssertion`, `finalizeMarket`, `voidMarket`) never
///      revert on a state or time they do not act in: they return false (or NOT_READY), because Monad
///      charges the full gas limit on a revert (§5.4). They revert only for an unknown market, invalid
///      input, or a guard error §5.4 names (`TooEarly`, `NoFeed`, ...).
///
///      Clocks (D3, ORC-11, ORC-12): at the halt the market copies the engine's `economicHaltAt` (T for
///      a scheduled halt, even when the keeper is late) and `oiHaltLots`, sets
///      `voidDeadline = max(haltedAt, T) + voidSecs` once, and pins the active trust set and the
///      registry's current globals version; every later read of a global uses that version.
///
///      Trust sets (D8): versioned bundles of every party a market trusts. IDs start at 1 (0 = none).
///      Governance creates and activates them; a market pins the active set at its halt and keeps it.
///      The guardian can only revoke, with immediate effect on pinned sets too. `BadTrustSet` codes are
///      C.3's 1-9 plus 0 = no such trust set (ADJ-31).
contract ResolutionOracle is EIP712, ReentrancyGuard {
    // ------------------------------------------------------------------ immutables (C.1)
    address public immutable registry; // MarketRegistry
    address public immutable treasury; // BondTreasury
    address public immutable usdc;
    uint64 public immutable monadChainSelector;
    address public immutable governance; // Timelock
    address public immutable guardian; // guardian Safe, revoke only
    bool public immutable simModeAllowed; // false on Monad mainnet (chainId 143)

    // ------------------------------------------------------------------ sim mode (O15.2)
    bool public simMode;

    // ------------------------------------------------------------------ trust sets
    uint32 public trustSetCount;
    uint32 public activeTrustSetId;
    mapping(uint32 setId => TrustSet) internal _trustSets;
    mapping(uint32 setId => mapping(address member => bool)) internal _memberRevoked;
    /// @dev Number of trust sets naming this address as their non-revoked watchdog (heartbeat auth).
    mapping(address watchdog => uint32) internal _watchdogSets;
    mapping(address watchdog => uint64) public lastHeartbeat;

    // ------------------------------------------------------------------ markets
    mapping(bytes32 id => bool) internal _initialized;
    mapping(bytes32 id => Resolution) internal _res;
    mapping(bytes32 id => string) internal _evidenceURI;
    mapping(bytes32 groupId => GroupState) internal _groups;

    modifier onlyGovernance() {
        if (msg.sender != governance) revert IResolutionOracle.Unauthorized();
        _;
    }

    modifier onlyGuardian() {
        if (msg.sender != guardian) revert IResolutionOracle.Unauthorized();
        _;
    }

    constructor(
        address registry_,
        address treasury_,
        address usdc_,
        uint64 monadChainSelector_,
        address governance_,
        address guardian_
    ) {
        registry = registry_;
        treasury = treasury_;
        usdc = usdc_;
        monadChainSelector = monadChainSelector_;
        governance = governance_;
        guardian = guardian_;
        simModeAllowed = block.chainid != OracleConst.MONAD_MAINNET_CHAIN_ID;
        simMode = simModeAllowed;
    }

    /// @dev EIP-712 domain ("ErosResolutionOracle", "1", chainId, this) (D7, Appendix C.7).
    function _domainNameAndVersion() internal pure override returns (string memory, string memory) {
        return ("ErosResolutionOracle", "1");
    }

    // ------------------------------------------------------------------ registry hook

    /// @notice MarketRegistry only, inside `createMarket`: creates the market's record in state None.
    function initResolution(bytes32 id) external nonReentrant {
        if (msg.sender != registry) revert IResolutionOracle.Unauthorized();
        if (_initialized[id]) revert IResolutionOracle.AlreadyInitialized();
        _initialized[id] = true;
        emit IResolutionOracle.ResolutionInitialized(id);
    }

    // ------------------------------------------------------------------ watchdog

    /// @notice Any non-revoked watchdog of any trust set, so a market pinned to an older set keeps its
    ///         watchdog's heartbeat (L1 and L2_AUTO liveness depend on it, D11).
    function watchdogHeartbeat() external nonReentrant {
        if (_watchdogSets[msg.sender] == 0) revert IResolutionOracle.Unauthorized();
        uint64 nowTs = uint64(block.timestamp);
        lastHeartbeat[msg.sender] = nowTs;
        emit IResolutionOracle.WatchdogHeartbeat(msg.sender, nowTs);
    }

    // ------------------------------------------------------------------ early check (§8.5)

    /// @notice The market's monitor, before T, once the engine is reduce-only (`requestReduceOnly`, S-09):
    ///         None → EarlyCheck. Reverts `Unauthorized` for any other caller, `WrongState` outside None or
    ///         at/after T, and `EngineCallFailed` while the engine is not monitor-restricted.
    function requestEarlyCheck(bytes32 id) external nonReentrant {
        Resolution storage r = _known(id);
        MarketCore memory c = _core(id);
        if (msg.sender != c.monitor) revert IResolutionOracle.Unauthorized();
        if (r.state != RState.None || block.timestamp >= c.tau) revert IResolutionOracle.WrongState(r.state);
        if (!IEngineMonitorView(c.engine).marketRiskView().monitorRestricted) {
            revert IResolutionOracle.EngineCallFailed();
        }
        r.earlyStartedAt = uint64(block.timestamp);
        _setState(id, r, RState.EarlyCheck);
        emit IResolutionOracle.EarlyCheckRequested(id, uint64(block.timestamp));
    }

    /// @notice EarlyCheck or EarlyReview → None once the early TTL has run out; false otherwise.
    function expireEarly(bytes32 id) external nonReentrant returns (bool changed) {
        Resolution storage r = _known(id);
        if (r.state != RState.EarlyCheck && r.state != RState.EarlyReview) return false;
        if (block.timestamp < uint256(r.earlyStartedAt) + _core(id).earlyTtlSecs) return false;
        _clearEarly(id, r, 1);
        return true;
    }

    // ------------------------------------------------------------------ lifecycle (permissionless)

    /// @notice At or after T, halts the engine (scheduled: `economicHaltAt = T`) from None, EarlyCheck or
    ///         EarlyReview, and moves a feed market to L1Pending, a market without a feed to L2Pending.
    /// @return changed false before T or once halted.
    function haltScheduled(bytes32 id) external nonReentrant returns (bool changed) {
        Resolution storage r = _known(id);
        MarketCore memory c = _core(id);
        if (block.timestamp < c.tau || !_isPreHalt(r.state)) return false;
        _haltToPending(id, r, c);
        return true;
    }

    /// @notice Emits the CRE log trigger for a feed market in L1Pending, halting it first when it is still
    ///         pre-halt. Reverts `NoFeed` without a feed and `TooEarly` before `T + bufferSecs`; returns
    ///         false (no event) in any other state or within `minRequestIntervalSecs` of the last request.
    function requestResolution(bytes32 id) external nonReentrant returns (bool emitted) {
        Resolution storage r = _known(id);
        MarketCore memory c = _core(id);
        if (!c.hasFeed) revert IResolutionOracle.NoFeed();
        if (block.timestamp < uint256(c.tau) + _feed(id).bufferSecs) revert IResolutionOracle.TooEarly();
        if (_isPreHalt(r.state)) _haltToPending(id, r, c);
        if (r.state != RState.L1Pending) return false;
        uint64 nowTs = uint64(block.timestamp);
        if (r.lastRequestAt != 0 && nowTs < r.lastRequestAt + _globals(r).minRequestIntervalSecs) return false;
        r.lastRequestAt = nowTs;
        uint32 count = ++r.requestCount;
        emit IResolutionOracle.ResolutionRequested(id, nowTs, count);
        return true;
    }

    /// @notice L1Pending → L2Pending once `T + l1TimeoutSecs` has passed (`l2StartedAt = now`).
    function escalateToL2(bytes32 id) external nonReentrant returns (bool changed) {
        Resolution storage r = _known(id);
        if (r.state != RState.L1Pending) return false;
        if (block.timestamp < uint256(_core(id).tau) + _feed(id).l1TimeoutSecs) return false;
        r.l2StartedAt = uint64(block.timestamp);
        _setState(id, r, RState.L2Pending);
        return true;
    }

    /// @notice L2Pending or Review → Open: at `retryOpensAt` when set (after a rejection or a group
    ///         conflict), otherwise at `l2StartedAt + l2DeadlineSecs`. An early-halted market stays
    ///         committee-only until T (ORC-15).
    function openAfterDeadline(bytes32 id) external nonReentrant returns (bool changed) {
        Resolution storage r = _known(id);
        if (r.state != RState.L2Pending && r.state != RState.Review) return false;
        MarketCore memory c = _core(id);
        if (block.timestamp < c.tau) return false;
        uint256 opensAt = r.retryOpensAt != 0 ? r.retryOpensAt : uint256(r.l2StartedAt) + c.l2DeadlineSecs;
        if (block.timestamp < opensAt) return false;
        _setState(id, r, RState.Open);
        return true;
    }

    // ------------------------------------------------------------------ panel (single attestor, relayed by anyone)

    /// @notice A signed panel result (EIP-712 `PanelResult`, D5). EarlyCheck (phase EARLY, active set):
    ///         three identical confident known labels, or any flag → EarlyReview (the committee decides);
    ///         otherwise → None. L2Pending (phase POST_T, pinned set): two or more NOT_YET → stays; the
    ///         auto gate passes → Proposed (L2_AUTO); otherwise → Review.
    function submitPanelResult(bytes32 id, PanelResult calldata p, string calldata evidenceURI, bytes calldata sig)
        external
        nonReentrant
        returns (RState routedTo)
    {
        Resolution storage r = _known(id);
        RState st = r.state;
        if (st == RState.EarlyCheck) {
            AIConfig memory ai = _checkPanel(id, r, p, evidenceURI, sig, Phase.EARLY, activeTrustSetId);
            if (p.flags != 0 || (_unanimous(p.labels, false) && _confident(p.calibratedBps, ai.highConfBps))) {
                r.earlyStartedAt = uint64(block.timestamp);
                _setState(id, r, RState.EarlyReview);
            } else {
                _clearEarly(id, r, 0);
            }
        } else if (st == RState.L2Pending) {
            AIConfig memory ai = _checkPanel(id, r, p, evidenceURI, sig, Phase.POST_T, r.trustSetId);
            uint256 notYet;
            for (uint256 i; i < 3; ++i) {
                if (p.labels[i] == uint8(PanelLabel.NOT_YET)) ++notYet;
            }
            if (notYet >= 2) {
                emit IResolutionOracle.PanelNotYet(id, p.attempt);
            } else if (_autoGate(r, p, ai) == 0) {
                _record(id, r, Outcome(p.labels[0]), Path.L2_AUTO, p.evidenceHash, evidenceURI);
            } else {
                _setState(id, r, RState.Review);
            }
        } else {
            revert IResolutionOracle.WrongState(st);
        }
        routedTo = r.state;
        emit IResolutionOracle.PanelResultAccepted(
            id, Phase(p.phase), p.labels, p.calibratedBps, p.evidenceHash, evidenceURI, routedTo
        );
    }

    /// @notice L2Pending only: records the panel's outcome as an L2_AUTO proposal, or reverts
    ///         `GateClosed(code)` when the auto gate (§6.4) does not pass.
    function submitPanelProposal(bytes32 id, PanelResult calldata p, string calldata evidenceURI, bytes calldata sig)
        external
        nonReentrant
    {
        Resolution storage r = _known(id);
        if (r.state != RState.L2Pending) revert IResolutionOracle.WrongState(r.state);
        AIConfig memory ai = _checkPanel(id, r, p, evidenceURI, sig, Phase.POST_T, r.trustSetId);
        uint8 code = _autoGate(r, p, ai);
        if (code != 0) revert IResolutionOracle.GateClosed(code);
        emit IResolutionOracle.PanelResultAccepted(
            id, Phase.POST_T, p.labels, p.calibratedBps, p.evidenceHash, evidenceURI, RState.Proposed
        );
        _record(id, r, Outcome(p.labels[0]), Path.L2_AUTO, p.evidenceHash, evidenceURI);
    }

    // ------------------------------------------------------------------ proposals

    /// @notice m-of-k committee proposal (EIP-712 `ReviewedProposal`, D7), relayed by anyone.
    ///         From Review or Open it uses the market's pinned trust set. From EarlyReview (before T and
    ///         within the early TTL) it uses the active set and halts the engine at once: the early
    ///         proposal's halt time is this block (§8.5). The outcome is then asserted by `assertProposal`.
    function submitReviewedProposal(
        bytes32 id,
        ReviewedProposal calldata p,
        string calldata evidenceURI,
        Sig[] calldata sigs
    ) external nonReentrant {
        Resolution storage r = _known(id);
        RState st = r.state;
        bool early = st == RState.EarlyReview;
        if (!early && st != RState.Review && st != RState.Open) revert IResolutionOracle.WrongState(st);
        MarketCore memory c = _core(id);
        if (early && (block.timestamp >= c.tau || block.timestamp >= uint256(r.earlyStartedAt) + c.earlyTtlSecs)) {
            revert IResolutionOracle.WrongState(st);
        }
        uint32 setId = early ? activeTrustSetId : r.trustSetId;
        _checkReviewedPayload(id, r, p, evidenceURI, early, setId);
        _verifyCommittee(setId, _hashTypedData(SigLib.hashReviewedProposal(p)), sigs);
        if (early) _recordHalt(id, r, c);
        _record(id, r, Outcome(p.outcome), Path.REVIEWED, p.evidenceHash, evidenceURI);
    }

    /// @notice Anyone, in Open, with their own bond: records the proposal and posts it on the pinned venue
    ///         in the same call (asserter = payer = caller, reviewed liveness). The caller must have
    ///         approved the venue for `bondFor(id)`. A Final permissionless proposal earns the reward of the
    ///         pinned globals version (R_p).
    function proposePermissionless(bytes32 id, Outcome outcome, string calldata evidenceURI, bytes32 evidenceHash)
        external
        nonReentrant
        returns (bytes32 assertionId)
    {
        Resolution storage r = _known(id);
        if (r.state != RState.Open) revert IResolutionOracle.WrongState(r.state);
        _checkOutcome(r, outcome);
        if (r.attempts >= OracleConst.A_MAX) revert IResolutionOracle.MaxAttempts();
        if (evidenceHash == 0) revert IResolutionOracle.BadPayload(5);
        _checkURI(evidenceURI, keccak256(bytes(evidenceURI)));
        _record(id, r, outcome, Path.PERMISSIONLESS, evidenceHash, evidenceURI);
        r.proposer = msg.sender;
        r.rewardAtoms = _globals(r).proposerRewardAtoms;
        assertionId = _assert(id, r, false);
    }

    // ------------------------------------------------------------------ assertions (anyone)

    /// @notice Posts a recorded team proposal (L1, L2_AUTO, REVIEWED) on the pinned venue with a treasury
    ///         bond. Returns false unless the market is Proposed without a live assertion. Reverts
    ///         `MaxAttempts`, `OutcomeNotAllowed`, `ExpiryAfterVoidDeadline` or `TreasuryShort` (the keeper
    ///         alerts and retries once the ledger is funded).
    function assertProposal(bytes32 id) external nonReentrant returns (bool asserted) {
        Resolution storage r = _known(id);
        if (r.state != RState.Proposed || r.assertionId != 0) return false;
        if (r.attempts >= OracleConst.A_MAX) revert IResolutionOracle.MaxAttempts();
        _checkOutcome(r, r.proposed);
        _assert(id, r, true);
        return true;
    }

    /// @notice Proposed → Disputed once the venue shows the live assertion disputed; false otherwise.
    function syncAssertion(bytes32 id) external nonReentrant returns (bool changed) {
        Resolution storage r = _known(id);
        if (r.state != RState.Proposed || r.assertionId == 0) return false;
        if (!IAssertionVenue(r.assertionVenue).statusOf(r.assertionId).disputed) return false;
        _markDisputed(id, r);
        return true;
    }

    /// @notice Settles the live assertion on the venue if it can (`trySettle` never reverts), then applies
    ///         what the venue shows, because anyone may have settled on the venue directly: true → Final,
    ///         false → rejection, disputed and unsettled → Disputed. NOT_READY when there is nothing to apply.
    function finalizeMarket(bytes32 id) external nonReentrant returns (FinalizeStatus status) {
        Resolution storage r = _known(id);
        if ((r.state != RState.Proposed && r.state != RState.Disputed) || r.assertionId == 0) {
            return FinalizeStatus.NOT_READY;
        }
        return _applyVenue(id, r);
    }

    /// @notice From `voidDeadline` on, any halted market that is not Final reaches Final (ORC-9). A live
    ///         assertion the venue has settled, or can settle now, is applied first; if that leaves the
    ///         market non-Final (a rejection with an outcome left), it is voided in the same call. Otherwise
    ///         → Voided → Final(INVALID, VOID_DEADLINE), a live team bond written off with `markStuck`.
    function voidMarket(bytes32 id) external nonReentrant returns (bool changed) {
        Resolution storage r = _known(id);
        if (r.state == RState.Final || r.voidDeadline == 0 || block.timestamp < r.voidDeadline) return false;
        if (r.assertionId != 0) {
            _applyVenue(id, r);
            if (r.state == RState.Final) return true;
            if (r.assertionId != 0 && r.path != Path.PERMISSIONLESS) {
                IBondTreasury(treasury).markStuck(id, r.attempts - 1);
            }
        }
        _void(id, r, FinalReason.VOID_DEADLINE);
        return true;
    }

    // ------------------------------------------------------------------ governance (Timelock)

    /// @notice Creates a trust set (not active until `activateTrustSet`). `BadTrustSet` codes:
    ///         1 forwarder, 2 workflowIds, 3 owner, 4 attestor, 5 committee, 6 threshold, 7 watchdog,
    ///         8 venue, 9 currency.
    function createTrustSet(TrustSetInput calldata t) external onlyGovernance nonReentrant returns (uint32 setId) {
        uint8 code = _trustSetCode(t);
        if (code != 0) revert IResolutionOracle.BadTrustSet(code);
        setId = ++trustSetCount;
        TrustSet storage s = _trustSets[setId];
        s.cfg = t;
        s.createdAt = uint64(block.timestamp);
        ++_watchdogSets[t.watchdog];
        emit IResolutionOracle.TrustSetCreated(setId, t.production);
    }

    /// @notice Markets halting from now on pin this set; markets already halted keep theirs.
    function activateTrustSet(uint32 setId) external onlyGovernance nonReentrant {
        _existingSet(setId);
        activeTrustSetId = setId;
        emit IResolutionOracle.TrustSetActivated(setId);
    }

    // ------------------------------------------------------------------ guardian (revoke only, immediate)

    function revokeWorkflowId(uint32 setId, bytes32 workflowId) external onlyGuardian nonReentrant {
        TrustSet storage s = _existingSet(setId);
        if (workflowId == 0) revert IResolutionOracle.BadTrustSet(2);
        bool found;
        for (uint256 i; i < 2; ++i) {
            if (s.cfg.workflowIds[i] == workflowId) (s.workflowIdRevoked[i], found) = (true, true);
        }
        if (!found) revert IResolutionOracle.BadTrustSet(2);
        emit IResolutionOracle.TrustSetRevoked(setId, 0, workflowId);
    }

    function revokeAttestor(uint32 setId) external onlyGuardian nonReentrant {
        TrustSet storage s = _existingSet(setId);
        s.attestorRevoked = true;
        emit IResolutionOracle.TrustSetRevoked(setId, 1, _word(s.cfg.runnerAttestor));
    }

    function revokeCommitteeMember(uint32 setId, address member) external onlyGuardian nonReentrant {
        TrustSet storage s = _existingSet(setId);
        if (!_isMember(s.cfg.committee, member)) revert IResolutionOracle.NotCommitteeMember(member);
        _memberRevoked[setId][member] = true;
        emit IResolutionOracle.TrustSetRevoked(setId, 2, _word(member));
    }

    function revokeWatchdog(uint32 setId) external onlyGuardian nonReentrant {
        TrustSet storage s = _existingSet(setId);
        if (!s.watchdogRevoked) {
            s.watchdogRevoked = true;
            --_watchdogSets[s.cfg.watchdog];
        }
        emit IResolutionOracle.TrustSetRevoked(setId, 3, _word(s.cfg.watchdog));
    }

    // ------------------------------------------------------------------ views

    /// @notice The single EVM read the CRE workflow makes (§7.3 step 2). An unknown market reads state 0.
    function getL1Job(bytes32 id)
        external
        view
        returns (uint8 state, FeedSpec memory spec, string[] memory allowList, bytes32 specHash)
    {
        state = uint8(_res[id].state);
        IMarketRegistry reg = IMarketRegistry(registry);
        spec = reg.getFeedSpec(id);
        allowList = reg.getAllowList(id);
        specHash = reg.getSpecHash(id);
    }

    /// @notice The bond of the market's next assertion (§6.5); 0 before the halt (no OI or venue pinned).
    function bondFor(bytes32 id) external view returns (uint256) {
        Resolution storage r = _res[id];
        if (r.trustSetId == 0) return 0;
        return _bond(id, r, IAssertionVenue(_trustSets[r.trustSetId].cfg.venue));
    }

    /// @notice The liveness of the recorded proposal's assertion (heartbeat fallback, D11); with no
    ///         proposal recorded, the reviewed liveness every later (committee or permissionless) proposal
    ///         gets. 0 for an unknown market (the registry's empty config).
    function livenessFor(bytes32 id) external view returns (uint64) {
        Resolution storage r = _res[id];
        if (r.proposed == Outcome.NONE) return IMarketRegistry(registry).getUMAConfig(id).livenessReviewed;
        return _liveness(id, r);
    }

    /// @notice The claim the recorded proposal is (or will be) asserted with; empty with no proposal.
    function renderClaim(bytes32 id) external view returns (bytes memory) {
        Resolution storage r = _res[id];
        if (r.proposed == Outcome.NONE) return "";
        return _claim(id, r);
    }

    function getResolution(bytes32 id) external view returns (Resolution memory) {
        return _res[id];
    }

    function evidenceURIOf(bytes32 id) external view returns (string memory) {
        return _evidenceURI[id];
    }

    function trustSet(uint32 setId) external view returns (TrustSet memory) {
        return _trustSets[setId];
    }

    function isMemberRevoked(uint32 setId, address member) external view returns (bool) {
        return _memberRevoked[setId][member];
    }

    function groupState(bytes32 groupId) external view returns (GroupState memory) {
        return _groups[groupId];
    }

    /// @notice The watchdog of the market's pinned trust set; 0 before the halt or once revoked.
    ///         BondTreasury authorizes `disputeViaVenue` with it.
    function watchdogOf(bytes32 id) external view returns (address) {
        uint32 setId = _res[id].trustSetId;
        if (setId == 0 || _trustSets[setId].watchdogRevoked) return address(0);
        return _trustSets[setId].cfg.watchdog;
    }

    // ------------------------------------------------------------------ internals

    /// @dev First failing `BadTrustSet` code (C.3), or 0.
    function _trustSetCode(TrustSetInput calldata t) internal view returns (uint8) {
        if (t.forwarder == address(0)) return 1;
        if (t.production && t.workflowIds[0] == 0) return 2;
        if (t.production && t.workflowOwner == address(0)) return 3;
        if (t.runnerAttestor == address(0)) return 4;
        address[] calldata c = t.committee;
        if (c.length == 0 || c[0] == address(0)) return 5;
        for (uint256 i = 1; i < c.length; ++i) {
            if (c[i] <= c[i - 1]) return 5; // strictly ascending: unique and non-zero
        }
        if (t.threshold == 0 || t.threshold > c.length) return 6;
        if (t.watchdog == address(0)) return 7;
        if (t.venue == address(0)) return 8;
        if (IAssertionVenue(t.venue).bondCurrency() != usdc) return 9;
        return 0;
    }

    function _existingSet(uint32 setId) internal view returns (TrustSet storage) {
        if (setId == 0 || setId > trustSetCount) revert IResolutionOracle.BadTrustSet(0);
        return _trustSets[setId];
    }

    function _isMember(address[] storage committee, address member) internal view returns (bool) {
        for (uint256 i; i < committee.length; ++i) {
            if (committee[i] == member) return true;
        }
        return false;
    }

    function _word(address a) internal pure returns (bytes32) {
        return bytes32(uint256(uint160(a)));
    }

    // ------------------------------------------------------------------ panel internals

    /// @dev `PanelResult` payload checks (§6.4): BadPayload 7 marketId, 2 attempt, 4 trust set, 5 evidence URI,
    ///      1 phase, 3 gateHash; `SignatureExpired`; `BadSignature` unless signed by the set's non-revoked
    ///      runner attestor. Returns the market's AI config for the routing.
    function _checkPanel(
        bytes32 id,
        Resolution storage r,
        PanelResult calldata p,
        string calldata evidenceURI,
        bytes calldata sig,
        Phase phase,
        uint32 setId
    ) internal view returns (AIConfig memory ai) {
        if (p.marketId != id) revert IResolutionOracle.BadPayload(7);
        if (block.timestamp > p.deadline) revert IResolutionOracle.SignatureExpired();
        if (p.attempt != r.attempts) revert IResolutionOracle.BadPayload(2);
        if (p.trustSetId != setId) revert IResolutionOracle.BadPayload(4);
        _checkURI(evidenceURI, p.evidenceURIHash);
        if (p.phase != uint8(phase)) revert IResolutionOracle.BadPayload(1);
        if (p.gateHash != _core(id).gateHash) revert IResolutionOracle.BadPayload(3);
        TrustSet storage s = _trustSets[setId];
        if (
            s.attestorRevoked
                || !SigLib.isValidAttestorSig(s.cfg.runnerAttestor, _hashTypedData(SigLib.hashPanelResult(p)), sig)
        ) revert IResolutionOracle.BadSignature();
        ai = IMarketRegistry(registry).getAIConfig(id);
    }

    /// @dev §6.4 auto gate on the pinned globals version; 0 when it passes, else the `GateClosed` code:
    ///      1 not 3/3 YES or 3/3 NO, 2 a confidence below θ_hi, 3 category not validated for this gateHash
    ///      before the halt or outside U95/N, 4 OI above the review limit, 5 flags, 6 no evidence hash.
    function _autoGate(Resolution storage r, PanelResult calldata p, AIConfig memory ai) internal view returns (uint8) {
        if (!_unanimous(p.labels, true)) return 1;
        if (!_confident(p.calibratedBps, ai.highConfBps)) return 2;
        Globals memory g = _globals(r);
        Category memory cat = IMarketRegistry(registry).category(ai.categoryId);
        if (
            !cat.validated || cat.gateHash != p.gateHash || cat.validatedAt > r.haltedAt || cat.u95Bps > g.deltaPmaxBps
                || cat.sampleN < g.nMin
        ) return 3;
        if (r.oiHaltLots * OracleConst.ATOMS_PER_LOT > g.reviewLimitAtoms) return 4;
        if (p.flags != 0) return 5;
        if (p.evidenceHash == 0) return 6;
        return 0;
    }

    /// @dev Three identical labels: YES or NO when `binary`, else YES, NO or INVALID.
    function _unanimous(uint8[3] calldata labels, bool binary) internal pure returns (bool) {
        uint8 l = labels[0];
        if (l != labels[1] || l != labels[2]) return false;
        return l == uint8(PanelLabel.YES) || l == uint8(PanelLabel.NO) || (!binary && l == uint8(PanelLabel.INVALID));
    }

    function _confident(uint16[3] calldata bps, uint16 floorBps) internal pure returns (bool) {
        return bps[0] >= floorBps && bps[1] >= floorBps && bps[2] >= floorBps;
    }

    /// @dev Back to None (`EarlyCheckCleared` reason 0 panel not known, 1 TTL).
    function _clearEarly(bytes32 id, Resolution storage r, uint8 reason) internal {
        r.earlyStartedAt = 0;
        _setState(id, r, RState.None);
        emit IResolutionOracle.EarlyCheckCleared(id, reason);
    }

    // ------------------------------------------------------------------ proposal internals

    /// @dev `ReviewedProposal` payload checks (§6.4): BadPayload 7 marketId, 2 attempt, 6 mask,
    ///      1 `early` must equal (state == EarlyReview), 4 trust set, 5 evidence URI; `SignatureExpired`;
    ///      `OutcomeNotAllowed` for NONE, an unknown value or a rejected outcome.
    function _checkReviewedPayload(
        bytes32 id,
        Resolution storage r,
        ReviewedProposal calldata p,
        string calldata evidenceURI,
        bool early,
        uint32 setId
    ) internal view {
        if (p.marketId != id) revert IResolutionOracle.BadPayload(7);
        if (block.timestamp > p.deadline) revert IResolutionOracle.SignatureExpired();
        if (p.attempt != r.attempts) revert IResolutionOracle.BadPayload(2);
        if (p.rejectedMask != r.rejectedMask) revert IResolutionOracle.BadPayload(6);
        if (p.early != early) revert IResolutionOracle.BadPayload(1);
        if (p.trustSetId != setId) revert IResolutionOracle.BadPayload(4);
        _checkURI(evidenceURI, p.evidenceURIHash);
        // A raw value above INVALID cannot be cast to Outcome; NONE is refused by `_checkOutcome`.
        if (p.outcome > uint8(Outcome.INVALID)) revert IResolutionOracle.OutcomeNotAllowed();
        _checkOutcome(r, Outcome(p.outcome));
    }

    /// @dev YES, NO or INVALID, and not an outcome the venue already rejected (ORC-6).
    function _checkOutcome(Resolution storage r, Outcome o) internal view {
        if (o == Outcome.NONE || (r.rejectedMask & (uint8(1) << uint8(o))) != 0) {
            revert IResolutionOracle.OutcomeNotAllowed();
        }
    }

    /// @dev `1 ≤ bytes(uri).length ≤ 256` and `keccak256(bytes(uri)) == uriHash`, else BadPayload(5).
    function _checkURI(string calldata uri, bytes32 uriHash) internal pure {
        uint256 len = bytes(uri).length;
        if (len == 0 || len > OracleConst.MAX_EVIDENCE_URI_BYTES || keccak256(bytes(uri)) != uriHash) {
            revert IResolutionOracle.BadPayload(5);
        }
    }

    /// @dev Strictly ascending, unique, non-revoked members of `setId`, at least its threshold (SigLib).
    function _verifyCommittee(uint32 setId, bytes32 digest, Sig[] calldata sigs) internal view {
        TrustSet storage s = _trustSets[setId];
        address[] memory committee = s.cfg.committee;
        bool[] memory revoked = new bool[](committee.length);
        for (uint256 i; i < committee.length; ++i) {
            revoked[i] = _memberRevoked[setId][committee[i]];
        }
        SigLib.verifyCommittee(digest, sigs, committee, revoked, s.cfg.threshold);
    }

    /// @dev Records a proposal and moves to Proposed (no live assertion yet).
    function _record(
        bytes32 id,
        Resolution storage r,
        Outcome outcome,
        Path path,
        bytes32 evidenceHash,
        string calldata evidenceURI
    ) internal {
        r.proposed = outcome;
        r.path = path;
        r.evidenceHash = evidenceHash;
        _evidenceURI[id] = evidenceURI;
        _setState(id, r, RState.Proposed);
        emit IResolutionOracle.ProposalRecorded(id, outcome, path, evidenceHash, evidenceURI, r.attempts);
    }

    // ------------------------------------------------------------------ assertion internals

    /// @dev Posts the recorded proposal on the pinned venue. Team paths: asserter and payer are the
    ///      treasury, which funds the bond from ASSERTION (`TreasuryShort` first, so the keeper gets the
    ///      amounts). Permissionless: the caller. Guards: the assertion must be able to finish before
    ///      `voidDeadline` (D10). Uses attempt index `attempts` and then increments it (ADJ-27).
    function _assert(bytes32 id, Resolution storage r, bool team) internal returns (bytes32 assertionId) {
        uint64 liveness = _liveness(id, r);
        if (block.timestamp + liveness > r.voidDeadline) revert IResolutionOracle.ExpiryAfterVoidDeadline();
        IAssertionVenue venue = IAssertionVenue(_trustSets[r.trustSetId].cfg.venue);
        uint256 bond = _bond(id, r, venue);
        address asserter = msg.sender;
        if (team) {
            asserter = treasury;
            uint256 have = IBondTreasury(treasury).balanceOf(Ledger.ASSERTION);
            if (have < bond) revert IResolutionOracle.TreasuryShort(bond, have);
            IBondTreasury(treasury).fundAssertion(id, r.attempts, address(venue), bond);
        }
        assertionId = venue.assertOutcome(
            IAssertionVenue.AssertRequest({
                marketId: id, claim: _claim(id, r), asserter: asserter, payer: asserter, liveness: liveness, bond: bond
            })
        );
        r.attempts += 1;
        r.assertionId = assertionId;
        r.assertionVenue = address(venue);
        r.bond = bond;
        emit IResolutionOracle.Asserted(
            id,
            assertionId,
            address(venue),
            r.proposed,
            r.path,
            bond,
            liveness,
            uint64(block.timestamp) + liveness,
            asserter
        );
    }

    /// @dev §6.5: max(minBond, venue minimum, ceil(oiHaltLots × 1000 × bondBps / 10 000)) USDC atoms.
    function _bond(bytes32 id, Resolution storage r, IAssertionVenue venue) internal view returns (uint256) {
        return BondMath.bond(r.oiHaltLots, IMarketRegistry(registry).getUMAConfig(id), venue.minimumBond());
    }

    /// @dev §6.4 `livenessFor`: L1 and L2_AUTO fall back to the reviewed liveness when the pinned watchdog
    ///      is revoked or its heartbeat is older than the pinned `heartbeatMaxAgeSecs` (D11).
    function _liveness(bytes32 id, Resolution storage r) internal view returns (uint64) {
        UMAConfig memory u = IMarketRegistry(registry).getUMAConfig(id);
        TrustSet storage s = _trustSets[r.trustSetId];
        bool fresh = BondMath.isWatchdogFresh(
            uint64(block.timestamp), lastHeartbeat[s.cfg.watchdog], _globals(r).heartbeatMaxAgeSecs, s.watchdogRevoked
        );
        return BondMath.liveness(r.path, u, fresh);
    }

    /// @dev The standalone claim (§6.4): the market's template with its question, rules, T, the proposed
    ///      outcome and the evidence (the URI, or for Layer 1 the value hash and the substituted source URL).
    function _claim(bytes32 id, Resolution storage r) internal view returns (bytes memory) {
        IMarketRegistry reg = IMarketRegistry(registry);
        ClaimRenderer.Fields memory f;
        f.marketId = id;
        f.chainId = block.chainid;
        f.oracle = address(this);
        f.question = reg.getQuestion(id);
        f.rules = reg.getRules(id);
        f.tau = reg.getMarketCore(id).tau;
        f.outcome = r.proposed;
        f.evidenceHash = r.evidenceHash;
        if (r.path == Path.L1) {
            FeedSpec memory spec = reg.getFeedSpec(id);
            f.evidence = ClaimRenderer.l1Evidence(r.valueHash, HostLib.substitute(spec.urlTemplate, spec.urlParam));
        } else {
            f.evidence = _evidenceURI[id];
        }
        return ClaimRenderer.render(reg.getClaimTemplate(id), f);
    }

    // ------------------------------------------------------------------ halt internals

    /// @dev Halts the engine and records the halt (ORC-11, ORC-12); a scheduled halt then goes to
    ///      L1Pending (feed) or L2Pending (no feed, `l2StartedAt = haltedAt`).
    function _haltToPending(bytes32 id, Resolution storage r, MarketCore memory c) internal {
        _recordHalt(id, r, c);
        if (c.hasFeed) {
            _setState(id, r, RState.L1Pending);
        } else {
            r.l2StartedAt = r.haltedAt;
            _setState(id, r, RState.L2Pending);
        }
    }

    /// @dev Calls `engine.halt()` (its revert bubbles up) and copies the snapshot; pins the active trust
    ///      set and the current globals version. A snapshot that is not halted reverts `EngineCallFailed`.
    /// @dev Applies what the venue shows for the live assertion after a `trySettle` attempt.
    function _applyVenue(bytes32 id, Resolution storage r) internal returns (FinalizeStatus) {
        IAssertionVenue venue = IAssertionVenue(r.assertionVenue);
        venue.trySettle(r.assertionId);
        IAssertionVenue.AssertionStatus memory st = venue.statusOf(r.assertionId);
        if (st.settled) {
            if (st.truthful) {
                _final(id, r, r.proposed, FinalReason.ASSERTED_TRUE);
                return FinalizeStatus.FINAL;
            }
            _reject(id, r);
            return FinalizeStatus.REJECTED;
        }
        if (!st.disputed) return FinalizeStatus.NOT_READY;
        if (r.state == RState.Proposed) _markDisputed(id, r);
        return FinalizeStatus.DISPUTED;
    }

    function _markDisputed(bytes32 id, Resolution storage r) internal {
        _setState(id, r, RState.Disputed);
        emit IResolutionOracle.Disputed(id, r.assertionId);
    }

    /// @dev §5.4 `_reject`: books the rejected outcome (ORC-6) and the lost team bond; YES and NO both
    ///      rejected → Voided → Final INVALID, else Review, committee-only until `retryOpensAt`.
    function _reject(bytes32 id, Resolution storage r) internal {
        Outcome o = r.proposed;
        bytes32 assertionId = r.assertionId;
        uint8 mask = r.rejectedMask | uint8(1) << uint8(o);
        r.rejectedMask = mask;
        r.assertionId = 0;
        r.proposed = Outcome.NONE;
        bool team = r.path != Path.PERMISSIONLESS;
        if (!team) (r.proposer, r.rewardAtoms) = (address(0), 0);
        bool both = mask & (OracleConst.MASK_YES | OracleConst.MASK_NO) == (OracleConst.MASK_YES | OracleConst.MASK_NO);
        uint64 retryOpensAt = both ? 0 : uint64(block.timestamp) + _core(id).retryWindowSecs;
        if (!both) r.retryOpensAt = retryOpensAt;
        emit IResolutionOracle.AssertionRejected(id, assertionId, o, mask, retryOpensAt);
        if (team) IBondTreasury(treasury).onBondLost(id, r.attempts - 1);
        if (both) _void(id, r, FinalReason.REJECTED_YES_AND_NO);
        else _setState(id, r, RState.Review);
    }

    function _void(bytes32 id, Resolution storage r, FinalReason reason) internal {
        r.voided = true;
        _setState(id, r, RState.Voided);
        emit IResolutionOracle.Voided(id, reason);
        _final(id, r, Outcome.INVALID, reason);
    }

    /// @dev §5.4 `_final`: Final, then the engine in the same transaction (an engine revert rolls the whole
    ///      call back, S-02), the treasury booking for ASSERTED_TRUE, and the listing commitment released.
    function _final(bytes32 id, Resolution storage r, Outcome o, FinalReason reason) internal {
        r.outcome = o;
        r.finalReason = reason;
        _setState(id, r, RState.Final);
        emit IResolutionOracle.Finalized(id, o, reason);
        IResolutionEngine engine = IResolutionEngine(_core(id).engine);
        if (o == Outcome.YES) engine.settle(1);
        else if (o == Outcome.NO) engine.settle(0);
        else engine.settleInvalid();
        IBondTreasury t = IBondTreasury(treasury);
        if (reason == FinalReason.ASSERTED_TRUE) {
            if (r.path == Path.PERMISSIONLESS) t.payProposerReward(id, r.proposer, r.rewardAtoms);
            else t.onBondReturned(id, r.attempts - 1);
        }
        t.releaseListing(id);
    }

    function _recordHalt(bytes32 id, Resolution storage r, MarketCore memory c) internal {
        uint32 setId = activeTrustSetId;
        if (setId == 0) revert IResolutionOracle.NoActiveTrustSet();
        HaltView memory h = IResolutionEngine(c.engine).halt();
        if (!h.halted) revert IResolutionOracle.EngineCallFailed();
        uint64 base = h.economicHaltAt > c.tau ? h.economicHaltAt : c.tau;
        r.haltedAt = h.economicHaltAt;
        r.oiHaltLots = h.oiHaltLots;
        r.voidDeadline = base + c.voidSecs;
        r.trustSetId = setId;
        r.globalsVersion = IMarketRegistry(registry).globalsVersion();
        emit IResolutionOracle.HaltRecorded(
            id, h.economicHaltAt, h.oiHaltLots, r.voidDeadline, setId, h.economicHaltAt < c.tau
        );
    }

    function _setState(bytes32 id, Resolution storage r, RState to) internal {
        RState from = r.state;
        r.state = to;
        emit IResolutionOracle.StateChanged(id, from, to);
    }

    function _isPreHalt(RState s) internal pure returns (bool) {
        return s == RState.None || s == RState.EarlyCheck || s == RState.EarlyReview;
    }

    function _core(bytes32 id) internal view returns (MarketCore memory) {
        return IMarketRegistry(registry).getMarketCore(id);
    }

    function _feed(bytes32 id) internal view returns (FeedSpec memory) {
        return IMarketRegistry(registry).getFeedSpec(id);
    }

    /// @dev The globals version the market pinned at its halt; the current version before the halt.
    function _globals(Resolution storage r) internal view returns (Globals memory) {
        IMarketRegistry reg = IMarketRegistry(registry);
        uint32 v = r.globalsVersion;
        return reg.globalsAt(v != 0 ? v : reg.globalsVersion());
    }

    /// @dev Reverts `UnknownMarket` for an id the registry never initialized.
    function _known(bytes32 id) internal view returns (Resolution storage r) {
        if (!_initialized[id]) revert IResolutionOracle.UnknownMarket();
        return _res[id];
    }
}
