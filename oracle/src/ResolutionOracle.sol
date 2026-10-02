// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {EIP712} from "solady/utils/EIP712.sol";
import {ReentrancyGuard} from "solady/utils/ReentrancyGuard.sol";
import {IResolutionEngine, HaltView} from "@eros/interfaces/IResolutionIngress.sol";
import {
    RState,
    Resolution,
    TrustSet,
    TrustSetInput,
    GroupState,
    MarketCore,
    FeedSpec,
    Globals,
    OracleConst
} from "./types/OracleTypes.sol";
import {IResolutionOracle} from "./interfaces/IResolutionOracle.sol";
import {IMarketRegistry} from "./interfaces/IMarketRegistry.sol";
import {IAssertionVenue} from "./interfaces/IAssertionVenue.sol";

/// @title ResolutionOracle
/// @notice The per-market resolution state machine (plan §5, §6.4, Appendix C.1, C.3). It is the engine's
///         pinned `resolutionAuthority` and the only contract that can halt or settle a market, so it is
///         not upgradeable and keeps one stable address. There is no pause and no admin path that moves a
///         market (D20): governance only manages trust sets and the sim-mode bridge, the guardian only
///         revokes, and every progress step is permissionless.
/// @dev Tasks O14.1 (constructor, trust sets, guardian revocations, `initResolution`, watchdog
///      heartbeat) and O14.2 (halt, request, escalate, open). Proposals, assertions, the panel and groups
///      follow in O14.3-O14.6, the CRE receiver in O15 and the EIP-712 views in O16, which also declares
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
