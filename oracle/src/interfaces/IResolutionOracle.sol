// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {
    Outcome,
    Path,
    RState,
    Phase,
    FinalReason,
    FinalizeStatus,
    FeedSpec,
    Resolution,
    TrustSet,
    TrustSetInput,
    GroupState,
    PanelResult,
    ReviewedProposal,
    Sig
} from "../types/OracleTypes.sol";
import {IReceiver} from "./IReceiver.sol";

interface IResolutionOracle is IReceiver {
    // ------------------------------------------------------------------ errors
    error Unauthorized();
    error UnknownMarket();
    error AlreadyInitialized();
    error WrongState(RState have);
    error TooEarly();
    error NoFeed();
    error NotSupported(); // feature disabled in this build (hackathon cut: early check)
    error BadMetadata();
    error WrongWorkflow();
    error BadReport(uint8 code); // 1 version, 2 selector, 3 oracle, 4 outcome, 5 specHash, 6 observedAt
    error SimModeOff();
    error ProductionSetRequired();
    error BadSignature();
    error SignatureExpired();
    error BadPayload(uint8 code); // 1 phase, 2 attempt, 3 gateHash, 4 trustSet, 5 evidenceURI, 6 mask, 7 marketId
    error GateClosed(uint8 code); // 1 split, 2 confidence, 3 category, 4 review limit, 5 flags, 6 evidence
    error OutcomeNotAllowed();
    error NotEnoughSignatures();
    error SignersNotSorted();
    error NotCommitteeMember(address signer);
    error MaxAttempts();
    error ExpiryAfterVoidDeadline();
    error GroupYesTaken();
    error TreasuryShort(uint256 need, uint256 have);
    error NoActiveTrustSet();
    error BadTrustSet(uint8 code); // 1 forwarder, 2 workflowIds, 3 owner, 4 attestor, 5 committee, 6 threshold, 7 watchdog, 8 venue, 9 currency
    error EngineCallFailed();

    // ------------------------------------------------------------------ events
    event ResolutionInitialized(bytes32 indexed id);
    event EarlyCheckRequested(bytes32 indexed id, uint64 at);
    event EarlyCheckCleared(bytes32 indexed id, uint8 reason); // 0 panel not known, 1 TTL
    event HaltRecorded(
        bytes32 indexed id, uint64 haltedAt, uint256 oiHaltLots, uint64 voidDeadline, uint32 trustSetId, bool early
    );
    event StateChanged(bytes32 indexed id, RState from, RState to);
    /// topic0 = 0xa3af2aef1d2a3c4b347e31fedf3782adb4c12febbd7961c698f034aed1a93a13 (CRE log trigger)
    event ResolutionRequested(bytes32 indexed id, uint64 requestedAt, uint32 requestCount);
    event ProposedL1(bytes32 indexed id, Outcome outcome, uint64 observedAt, bytes32 valueHash, bytes32 evidenceHash);
    event PanelResultAccepted(
        bytes32 indexed id,
        Phase phase,
        uint8[3] labels,
        uint16[3] calibratedBps,
        bytes32 evidenceHash,
        string evidenceURI,
        RState routedTo
    );
    event PanelNotYet(bytes32 indexed id, uint8 attempt);
    event ProposalRecorded(
        bytes32 indexed id, Outcome outcome, Path path, bytes32 evidenceHash, string evidenceURI, uint8 attempt
    );
    event Asserted(
        bytes32 indexed id,
        bytes32 indexed assertionId,
        address venue,
        Outcome outcome,
        Path path,
        uint256 bond,
        uint64 liveness,
        uint64 expiresAt,
        address asserter
    );
    event Disputed(bytes32 indexed id, bytes32 indexed assertionId);
    event AssertionRejected(
        bytes32 indexed id, bytes32 indexed assertionId, Outcome outcome, uint8 rejectedMask, uint64 retryOpensAt
    );
    event GroupLock(bytes32 indexed groupId, bytes32 indexed id, bool acquired);
    event GroupConflict(bytes32 indexed groupId, bytes32 indexed id);
    event Finalized(bytes32 indexed id, Outcome outcome, FinalReason reason);
    event Voided(bytes32 indexed id, FinalReason reason);
    event WatchdogHeartbeat(address indexed watchdog, uint64 at);
    event TrustSetCreated(uint32 indexed setId, bool production);
    event TrustSetActivated(uint32 indexed setId);
    event TrustSetRevoked(uint32 indexed setId, uint8 what, bytes32 detail); // 0 workflowId, 1 attestor, 2 member, 3 watchdog
    event SimForwarderSet(address forwarder);
    event SimRelayerSet(address indexed relayer, bool allowed);
    event ProductionLocked();

    // ------------------------------------------------------------------ registry hook
    function initResolution(bytes32 id) external; // MarketRegistry only

    // ------------------------------------------------------------------ lifecycle (permissionless unless noted)
    function requestEarlyCheck(bytes32 id) external; // market's monitor only
    function expireEarly(bytes32 id) external returns (bool changed);
    function haltScheduled(bytes32 id) external returns (bool changed);
    function requestResolution(bytes32 id) external returns (bool emitted);
    function escalateToL2(bytes32 id) external returns (bool changed);
    function openAfterDeadline(bytes32 id) external returns (bool changed);

    // ------------------------------------------------------------------ proposals
    function submitPanelResult(bytes32 id, PanelResult calldata r, string calldata evidenceURI, bytes calldata sig)
        external
        returns (RState routedTo);
    function submitPanelProposal(bytes32 id, PanelResult calldata r, string calldata evidenceURI, bytes calldata sig)
        external;
    function submitReviewedProposal(
        bytes32 id,
        ReviewedProposal calldata p,
        string calldata evidenceURI,
        Sig[] calldata sigs
    ) external;
    function proposePermissionless(bytes32 id, Outcome outcome, string calldata evidenceURI, bytes32 evidenceHash)
        external
        returns (bytes32 assertionId);

    // ------------------------------------------------------------------ assertions
    function assertProposal(bytes32 id) external returns (bool asserted);
    function syncAssertion(bytes32 id) external returns (bool changed);
    function finalizeMarket(bytes32 id) external returns (FinalizeStatus status);
    function voidMarket(bytes32 id) external returns (bool changed);

    // ------------------------------------------------------------------ watchdog
    function watchdogHeartbeat() external; // any non-revoked watchdog of any trust set

    // ------------------------------------------------------------------ governance (Timelock)
    function createTrustSet(TrustSetInput calldata t) external returns (uint32 setId);
    function activateTrustSet(uint32 setId) external;
    function setSimForwarder(address forwarder) external; // only while simMode
    function setSimRelayer(address relayer, bool allowed) external; // only while simMode
    function lockProduction() external; // one-way

    // ------------------------------------------------------------------ guardian (revoke only, immediate)
    function revokeWorkflowId(uint32 setId, bytes32 workflowId) external;
    function revokeAttestor(uint32 setId) external;
    function revokeCommitteeMember(uint32 setId, address member) external;
    function revokeWatchdog(uint32 setId) external;

    // ------------------------------------------------------------------ views
    function getResolution(bytes32 id) external view returns (Resolution memory);
    function evidenceURIOf(bytes32 id) external view returns (string memory);
    function getL1Job(bytes32 id)
        external
        view
        returns (uint8 state, FeedSpec memory spec, string[] memory allowList, bytes32 specHash);
    function bondFor(bytes32 id) external view returns (uint256);
    function livenessFor(bytes32 id) external view returns (uint64);
    function renderClaim(bytes32 id) external view returns (bytes memory);
    function watchdogOf(bytes32 id) external view returns (address); // pinned set's watchdog; 0 if revoked
    function trustSet(uint32 setId) external view returns (TrustSet memory);
    function isMemberRevoked(uint32 setId, address member) external view returns (bool);
    function activeTrustSetId() external view returns (uint32);
    function groupState(bytes32 groupId) external view returns (GroupState memory);
    function lastHeartbeat(address watchdog) external view returns (uint64);
    function simMode() external view returns (bool);
    function simForwarder() external view returns (address);
    function isSimRelayer(address relayer) external view returns (bool);
    function hashPanelResult(PanelResult calldata r) external view returns (bytes32 digest); // EIP-712 digest
    function hashReviewedProposal(ReviewedProposal calldata p) external view returns (bytes32 digest);
    function domainSeparator() external view returns (bytes32);
}
