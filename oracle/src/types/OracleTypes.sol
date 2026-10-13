// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

// Normative types for the Eros Markets oracle. Enum values are ABI: never reorder or insert.
// The CRE workflow hard-codes RState.L1Pending == 3.

enum Outcome {
    NONE,
    YES,
    NO,
    INVALID
}

enum Path {
    NONE,
    L1,
    L2_AUTO,
    REVIEWED,
    PERMISSIONLESS
}

enum RState {
    None, // 0
    EarlyCheck, // 1
    EarlyReview, // 2
    L1Pending, // 3
    L2Pending, // 4
    Review, // 5
    Open, // 6
    Proposed, // 7
    Disputed, // 8
    Voided, // 9 (transient: always followed by Final in the same tx)
    Final // 10
}

enum PanelLabel {
    ABSTAIN,
    YES,
    NO,
    INVALID,
    NOT_YET
}

enum Phase {
    NONE,
    EARLY,
    POST_T
}

enum FinalReason {
    NONE,
    ASSERTED_TRUE,
    REJECTED_YES_AND_NO,
    VOID_DEADLINE
}

enum ValueType {
    STRING,
    INT,
    DECIMAL
}

enum Op {
    EQ,
    NEQ,
    GT,
    GTE,
    LT,
    LTE
}

enum Ledger {
    ASSERTION,
    WATCHDOG_FLOAT,
    PROPOSER_REWARD
}

enum FinalizeStatus {
    NOT_READY, // nothing to apply yet (liveness running, DVM pending, or no live assertion)
    FINAL, // assertion settled true -> Final
    REJECTED, // assertion settled false -> Review, or Voided -> Final when YES and NO are both rejected
    DISPUTED // live assertion is disputed and unsettled -> state Disputed
}

library OracleConst {
    uint8 internal constant A_MAX = 3;
    uint8 internal constant REPORT_VERSION = 1;
    uint8 internal constant FLAG_INJECTION_SUSPECTED = 1; // PanelResult.flags bit 0
    uint8 internal constant MASK_YES = 2; // 1 << uint8(Outcome.YES)
    uint8 internal constant MASK_NO = 4; // 1 << uint8(Outcome.NO)
    uint8 internal constant MASK_INVALID = 8; // 1 << uint8(Outcome.INVALID)
    uint256 internal constant ATOMS_PER_LOT = 1000; // 1 lot = 0.001 claim; 1 claim pays 1e6 USDC atoms at YES
    uint256 internal constant BPS = 10_000;
    uint256 internal constant MAX_EVIDENCE_URI_BYTES = 256;
    uint64 internal constant ENGINE_CAPTURE_GRACE_SECS = 3600; // engine InvalidRule.captureGraceSecs
    uint256 internal constant ENGINE_FALLBACK_PRICE_WAD = 5e17; // engine InvalidRule.fallbackPriceWad
    uint256 internal constant MONAD_MAINNET_CHAIN_ID = 143;
    uint64 internal constant MONAD_TESTNET_SELECTOR = 2183018362218727504;
    uint64 internal constant MONAD_MAINNET_SELECTOR = 8481857512324358265;
}

/// @dev ABI-identical to the CRE workflow tuple. specHash = keccak256(abi.encode(spec)).
struct FeedSpec {
    string urlTemplate;
    string urlParam;
    bytes32 authRef; // 0 = no auth
    string finalPath;
    string finalValue;
    string valuePath;
    uint8 valueType; // ValueType
    uint8 decimals;
    uint8 op; // Op
    string target;
    uint32 bufferSecs;
    uint32 l1TimeoutSecs;
}

struct AIConfig {
    address allowListPtr; // SSTORE2: abi.encode(string[] hosts), Layer 1 host first. Ignored on input.
    bytes32[3] modelIdHashes; // keccak256("provider:model-id@version")
    bytes32 promptHash;
    bytes32 calibratorHash;
    bytes32 categoryId;
    uint16 highConfBps; // theta_hi on calibrated confidence
}

struct UMAConfig {
    address bondCurrency; // == USDC of this deployment
    uint256 minBond; // >= venue.minimumBond() at listing
    uint16 bondBps; // >= globals.bondBpsFloor
    uint64 livenessL1;
    uint64 livenessAuto;
    uint64 livenessReviewed;
    address claimTemplatePtr; // SSTORE2. Ignored on input.
}

/// @dev Written once in createMarket; no setters.
struct MarketCore {
    address engine;
    address questionPtr; // SSTORE2
    address rulesPtr; // SSTORE2
    uint64 listedAt;
    uint64 windowStart;
    uint64 windowEnd;
    uint64 tau; // scheduled T == engine listing.scheduledT
    bytes32 groupId; // 0 = none
    bool groupExclusive;
    bool hasFeed;
    uint32 l2DeadlineSecs;
    uint32 voidSecs; // == engine listing.invalidRule.voidSecs
    uint32 retryWindowSecs; // copied from globals at listing
    uint32 earlyTtlSecs; // copied from globals at listing
    address monitor; // == engine listing.monitor
    uint256 oiCapLots;
    bytes32 rulesHash; // keccak256(bytes(rules)) == engine listing.rulesHash
    bytes32 specHash; // keccak256(abi.encode(feed)); 0-spec hash when !hasFeed
    bytes32 gateHash; // keccak256(abi.encode(modelIdHashes, promptHash, calibratorHash, highConfBps))
}

/// @dev createMarket calldata: everything the listing pack produces.
struct MarketInput {
    bytes32 marketId;
    string question;
    string rules;
    string claimTemplate;
    uint64 windowStart;
    uint64 windowEnd;
    uint64 tau;
    bytes32 groupId;
    bool groupExclusive;
    bool hasFeed;
    FeedSpec feed; // all-zero when !hasFeed
    string[] allowList; // Layer 1 host first
    AIConfig ai;
    UMAConfig uma;
    uint32 l2DeadlineSecs;
    uint32 voidSecs;
    address monitor;
    uint256 oiCapLots;
    bytes32 dryRunHash; // keccak256 of the listing pack's reference.json
    bytes32 ambiguityLogHash; // keccak256 of the ambiguity-pass log
}

struct Globals {
    // read by createMarket only
    uint32 minHorizonSecs; // T - listedAt lower bound
    uint32 maxListingHorizon; // T - listedAt upper bound
    uint32 maxVoidSecs;
    uint32 l2MinSecs;
    uint32 l2MaxSecs;
    uint32 bufferMinSecs;
    uint32 bufferMaxSecs;
    uint32 l1TimeoutMinSecs;
    uint32 l1TimeoutMaxSecs;
    uint32 tMinSecs; // minimum liveness
    uint16 bondBpsFloor;
    uint16 highConfFloorBps;
    uint32 maxClaimBytes;
    // VoidBound inputs (createMarket only)
    uint32 dvmRoundSecs;
    uint8 dvmMaxRolls;
    uint32 reviewTargetSecs;
    uint32 voidSlackSecs;
    // copied into MarketCore at listing
    uint32 retryWindowSecs;
    uint32 earlyTtlSecs;
    // read by the oracle from the version each market pins at its halt (before the halt: the current version)
    uint32 minRequestIntervalSecs;
    uint32 heartbeatMaxAgeSecs;
    uint16 deltaPmaxBps;
    uint32 nMin;
    uint256 reviewLimitAtoms;
    uint256 proposerRewardAtoms; // R_p, copied into the Resolution at proposePermissionless
}

struct Category {
    bytes32 gateHash;
    uint16 u95Bps;
    uint32 sampleN; // unique parent markets
    bool validated;
    uint64 validatedAt; // auto gate needs validated && validatedAt <= haltedAt; revocation applies at once
}

struct GroupInfo {
    bool exists;
    bool exclusive;
}

struct TrustSetInput {
    address forwarder; // KeystoneForwarder (production) or MockKeystoneForwarder (sim)
    bool production;
    bytes32[2] workflowIds; // accepted Layer 1 workflow IDs; [old, new] during a redeploy
    address workflowOwner; // CRE org owner (private registry)
    bytes10 workflowName; // 0 = not checked
    address runnerAttestor;
    address[] committee; // strictly ascending, non-zero
    uint8 threshold; // 1 <= threshold <= committee.length
    address watchdog;
    address venue; // IAssertionVenue
}

struct TrustSet {
    TrustSetInput cfg;
    bool[2] workflowIdRevoked;
    bool attestorRevoked;
    bool watchdogRevoked;
    uint64 createdAt;
    // committee member revocations: ResolutionOracle.isMemberRevoked(setId, member)
}

/// @dev The only mutable per-market record.
struct Resolution {
    RState state;
    Outcome proposed;
    Path path;
    uint8 attempts; // assertions made, <= A_MAX
    uint8 rejectedMask; // bit (1 << Outcome) per outcome the venue rejected
    Outcome outcome; // set once, at Final
    FinalReason finalReason;
    bool voided;
    uint64 haltedAt; // == engine HaltView.economicHaltAt; 0 before the halt
    uint64 voidDeadline; // max(haltedAt, tau) + voidSecs; set once at the halt
    uint64 l2StartedAt; // haltedAt for no-feed markets, escalation time otherwise
    uint64 retryOpensAt; // after a rejection or group conflict: committee-only until then
    uint64 earlyStartedAt; // EarlyCheck / EarlyReview TTL anchor
    uint64 lastRequestAt; // requestResolution rate limit
    uint32 requestCount;
    uint32 trustSetId; // pinned at the halt
    uint32 globalsVersion; // registry globals version pinned at the halt
    uint256 oiHaltLots; // copied from the engine snapshot
    bytes32 evidenceHash; // L1: keccak256(report); other paths: snapshot hash
    bytes32 valueHash; // L1 only
    bytes32 assertionId; // live assertion; 0 = none
    address assertionVenue;
    uint256 bond; // bond of the live assertion
    address proposer; // permissionless proposer
    uint256 rewardAtoms; // R_p promised to the permissionless proposer
}

struct GroupState {
    bytes32 yesLockHolder; // market holding the live-YES lock; 0 = free
    bytes32 finalYes; // market that finalized YES; 0 = none
}

/// @dev EIP-712: PanelResult(bytes32 marketId,uint8 phase,uint8 attempt,uint8[3] labels,uint16[3] calibratedBps,
///      bytes32 evidenceHash,bytes32 evidenceURIHash,bytes32 gateHash,uint8 flags,uint32 trustSetId,uint64 deadline)
struct PanelResult {
    bytes32 marketId;
    uint8 phase; // Phase
    uint8 attempt; // == Resolution.attempts
    uint8[3] labels; // PanelLabel per model, in modelIdHashes order
    uint16[3] calibratedBps; // floor(c_hat * 10000)
    bytes32 evidenceHash;
    bytes32 evidenceURIHash; // keccak256(bytes(evidenceURI))
    bytes32 gateHash;
    uint8 flags; // FLAG_INJECTION_SUSPECTED, ...
    uint32 trustSetId;
    uint64 deadline;
}

/// @dev EIP-712: ReviewedProposal(bytes32 marketId,uint8 outcome,bytes32 evidenceHash,bytes32 evidenceURIHash,
///      bytes32 noteHash,uint8 attempt,uint8 rejectedMask,bool early,uint32 trustSetId,uint64 deadline)
struct ReviewedProposal {
    bytes32 marketId;
    uint8 outcome; // Outcome: YES, NO or INVALID
    bytes32 evidenceHash;
    bytes32 evidenceURIHash;
    bytes32 noteHash; // keccak256(JCS(note)); note pinned to IPFS
    uint8 attempt; // == Resolution.attempts
    uint8 rejectedMask; // == Resolution.rejectedMask
    bool early; // true only from EarlyReview
    uint32 trustSetId;
    uint64 deadline;
}

/// @dev Committee signatures: strictly ascending by signer. signature = 65-byte (r,s,v) for EOAs, or ERC-1271 data.
struct Sig {
    address signer;
    bytes signature;
}
