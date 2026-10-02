// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {SSTORE2} from "solady/utils/SSTORE2.sol";
import {IMarketConfig} from "@eros/interfaces/IMarketConfig.sol";
import {IResolutionEngine} from "@eros/interfaces/IResolutionIngress.sol";
import {
    Globals,
    Category,
    GroupInfo,
    MarketCore,
    MarketInput,
    FeedSpec,
    AIConfig,
    UMAConfig,
    OracleConst
} from "./types/OracleTypes.sol";
import {IMarketRegistry} from "./interfaces/IMarketRegistry.sol";
import {IResolutionOracle} from "./interfaces/IResolutionOracle.sol";
import {IAssertionVenue} from "./interfaces/IAssertionVenue.sol";
import {IBondTreasury} from "./interfaces/IBondTreasury.sol";
import {IMarketFactory} from "./interfaces/IMarketFactory.sol";
import {HostLib} from "./libraries/HostLib.sol";
import {BondMath} from "./libraries/BondMath.sol";
import {FeedSpecLib} from "./libraries/FeedSpecLib.sol";
import {ClaimRenderer} from "./libraries/ClaimRenderer.sol";
import {VoidBound} from "./libraries/VoidBound.sol";

/// @title MarketRegistry
/// @notice Immutable per-market resolution config and the bounded, versioned listing globals
///         (plan §6.3, §14.4, Appendix C.1, C.4). Not upgradeable; governance is the Timelock.
/// @dev Tasks O11.2 (storage, globals, governance setters), O11.3 (`createMarket` rules 1-6) and O11.4
///      (`createMarket` steps 7-9 and the market views).
///
///      `createMarket` is the only way to list a market. Order: lister check, factory set, rules 1-6,
///      step 7 treasury commitment at the OI cap, step 8 engine handshake through the factory, step 9
///      SSTORE2 text, structs, `initResolution` and `MarketListed`. Every external call goes to a
///      governance-set contract (treasury, factory, oracle) and the call is lister-only and atomic: any
///      revert undoes the whole listing. Nothing a market stores has a setter (ORC-1).
///
///      `specHash = keccak256(abi.encode(feed))` for every market, so a market without a feed stores the
///      hash of the all-zero FeedSpec. Market views return empty values for an id that was never listed;
///      `isListed` tells the two apart.
///
///      Globals are append-only: `setGlobals` writes version `globalsVersion + 1` and every earlier
///      version stays readable through `globalsAt` (markets pin the version current at their halt).
///      Version 0 never exists. `BadGlobals` codes (ADJ-30), one per §14.4 row, checked in this order:
///      0 version does not exist, 1 listing horizon, 2 l2 bounds, 3 buffer bounds, 4 l1Timeout bounds,
///      5 maxVoidSecs, 6 tMinSecs, 7 bondBpsFloor, 8 highConfFloorBps, 9 maxClaimBytes, 10 DVM round
///      and rolls, 11 reviewTarget and voidSlack, 12 retryWindowSecs, 13 earlyTtlSecs,
///      14 minRequestIntervalSecs, 15 heartbeatMaxAgeSecs, 16 deltaPmaxBps and nMin,
///      17 proposerRewardAtoms. `reviewLimitAtoms` has no onchain bound (§14.4: raised only from a
///      measured U95, §10 step 7). The extra column of §14.4 applies when `block.chainid == 143`.
contract MarketRegistry is IMarketRegistry {
    // ------------------------------------------------------------------ §14.4 bounds
    uint32 internal constant MIN_SECS = 60; // floor for every "min ≥ 60" rule
    uint32 internal constant MAX_LISTING_HORIZON = 2_588_400; // A's RiskStorage: 30 days − 1 h
    uint32 internal constant MAINNET_MIN_HORIZON = 86_400; // engine MIN_LISTING_HORIZON
    uint32 internal constant MAINNET_L2_MIN = 3_600;
    uint32 internal constant MAX_VOID_SECS = 90 days;
    uint32 internal constant MAINNET_T_MIN = 7_200;
    uint16 internal constant MAINNET_BOND_BPS_FLOOR = 1_112;
    uint16 internal constant HIGH_CONF_FLOOR = 5_000;
    uint16 internal constant MAINNET_HIGH_CONF_FLOOR = 9_000;
    uint32 internal constant MAX_CLAIM_BYTES = 32_768;
    uint32 internal constant MAINNET_DVM_ROUND = 172_800;
    uint8 internal constant MAINNET_DVM_ROLLS = 4;
    uint32 internal constant MAINNET_REVIEW_TARGET = 7_200;
    uint32 internal constant MAINNET_VOID_SLACK = 172_800;
    uint32 internal constant MAINNET_RETRY_WINDOW = 3_600;
    uint32 internal constant MAX_EARLY_TTL = 86_400;
    uint32 internal constant MAINNET_EARLY_TTL = 3_600;
    uint32 internal constant MAX_REQUEST_INTERVAL = 3_600;
    uint32 internal constant MIN_HEARTBEAT_AGE = 300;
    uint32 internal constant MAX_HEARTBEAT_AGE = 3_600;
    uint16 internal constant MAX_DELTA_PMAX_BPS = 200;
    uint32 internal constant MAINNET_N_MIN = 150;
    uint256 internal constant MAX_PROPOSER_REWARD = 1_000e6; // 1,000 USDC

    // ------------------------------------------------------------------ immutables (C.1)
    address public immutable oracle;
    address public immutable treasury;
    address public immutable usdc;
    address public immutable governance;

    // ------------------------------------------------------------------ governance-set state
    address public factory; // 0 until set on mainnet; createMarket then reverts NoFactory
    address public lister;
    uint32 public globalsVersion; // 0 = no globals yet
    mapping(uint32 version => Globals) internal _globals;
    mapping(bytes32 hostHash => bool) internal _providerAllowed;
    mapping(bytes32 authRef => bool) public authRefKnown;
    mapping(bytes32 categoryId => Category) internal _categories;
    mapping(bytes32 groupId => GroupInfo) internal _groups;

    // ------------------------------------------------------------------ listed markets (written in createMarket)
    mapping(bytes32 marketId => MarketCore) internal _cores; // engine != 0 <=> listed
    mapping(bytes32 marketId => FeedSpec) internal _feeds;
    mapping(bytes32 marketId => AIConfig) internal _ai;
    mapping(bytes32 marketId => UMAConfig) internal _uma;

    modifier onlyGovernance() {
        if (msg.sender != governance) revert Unauthorized();
        _;
    }

    /// @param factory_ may be 0 (mainnet before the shared MarketFactory exists).
    constructor(
        address oracle_,
        address treasury_,
        address factory_,
        address usdc_,
        address governance_,
        address lister_
    ) {
        oracle = oracle_;
        treasury = treasury_;
        factory = factory_;
        usdc = usdc_;
        governance = governance_;
        lister = lister_;
    }

    // ------------------------------------------------------------------ listing (§6.3)

    /// @notice Lister only. Validates every field (rules 1-6), commits the treasury bond at the OI cap,
    ///         deploys the engine through the factory, checks the handshake, stores the config and
    ///         initializes the Resolution (steps 7-9).
    function createMarket(
        MarketInput calldata m,
        IMarketConfig.Listing calldata engineListing,
        bytes calldata engineInit
    ) external returns (address engine) {
        if (msg.sender != lister) revert Unauthorized();
        if (factory == address(0)) revert NoFactory();
        (Globals memory g, uint256 venueMin) = _validateMarket(m);
        // Step 7: the ASSERTION ledger must cover every listed market's bond at its OI cap (§6.6).
        IBondTreasury(treasury).commitListing(m.marketId, BondMath.bond(m.oiCapLots, m.uma, venueMin));
        bytes32 specHash = FeedSpecLib.specHash(m.feed);
        engine = _deployEngine(m, engineListing, engineInit, specHash); // step 8
        _store(m, g, engine, specHash); // step 9
        IResolutionOracle(oracle).initResolution(m.marketId);
        _emitListed(m);
    }

    // ------------------------------------------------------------------ governance (Timelock)

    /// @notice Hosts every market's allow-list must come from (§6.3 rule 4).
    function setProvider(string calldata host, bool allowed) external onlyGovernance {
        _providerAllowed[keccak256(bytes(host))] = allowed;
        emit ProviderSet(host, allowed);
    }

    /// @notice Auth references the workflow config can resolve (§6.3 rule 3, §7.4).
    function setAuthRef(bytes32 authRef, bool known) external onlyGovernance {
        authRefKnown[authRef] = known;
        emit AuthRefSet(authRef, known);
    }

    /// @notice Every validated call stamps `validatedAt = now` (so changing a validated category restarts
    ///         its clock); an unvalidated call clears it (§6.3).
    function setCategory(bytes32 categoryId, bytes32 gateHash, uint16 u95Bps, uint32 sampleN, bool validated)
        external
        onlyGovernance
    {
        _categories[categoryId] =
            Category(gateHash, u95Bps, sampleN, validated, validated ? uint64(block.timestamp) : 0);
        emit CategorySet(categoryId, gateHash, u95Bps, sampleN, validated);
    }

    /// @notice Appends a new globals version after checking every §14.4 bound.
    function setGlobals(Globals calldata g) external onlyGovernance {
        uint8 code = _globalsCode(g, block.chainid == OracleConst.MONAD_MAINNET_CHAIN_ID);
        if (code != 0) revert BadGlobals(code);
        uint32 v = ++globalsVersion;
        _globals[v] = g;
        emit GlobalsSet(v, keccak256(abi.encode(g)));
    }

    function setLister(address lister_) external onlyGovernance {
        lister = lister_;
        emit ListerSet(lister_);
    }

    /// @notice Future listings only: listed markets store their own engine address.
    function setFactory(address factory_) external onlyGovernance {
        factory = factory_;
        emit FactorySet(factory_);
    }

    // ------------------------------------------------------------------ views

    /// @notice The current globals version; reverts `BadGlobals(0)` before the first `setGlobals`.
    function globals() external view returns (Globals memory) {
        return globalsAt(globalsVersion);
    }

    /// @notice Any version ever set; reverts `BadGlobals(0)` for version 0 or one not set yet.
    function globalsAt(uint32 version) public view returns (Globals memory) {
        if (version == 0 || version > globalsVersion) revert BadGlobals(0);
        return _globals[version];
    }

    function providerAllowed(string calldata host) external view returns (bool) {
        return _providerAllowed[keccak256(bytes(host))];
    }

    function category(bytes32 categoryId) external view returns (Category memory) {
        return _categories[categoryId];
    }

    function groupInfo(bytes32 groupId) external view returns (GroupInfo memory) {
        return _groups[groupId];
    }

    function isListed(bytes32 id) external view returns (bool) {
        return _cores[id].engine != address(0);
    }

    function getMarketCore(bytes32 id) external view returns (MarketCore memory) {
        return _cores[id];
    }

    function getFeedSpec(bytes32 id) external view returns (FeedSpec memory) {
        return _feeds[id];
    }

    function getSpecHash(bytes32 id) external view returns (bytes32) {
        return _cores[id].specHash;
    }

    /// @notice The market's allow-list, Layer 1 host first.
    function getAllowList(bytes32 id) external view returns (string[] memory hosts) {
        address p = _ai[id].allowListPtr;
        if (p == address(0)) return hosts;
        return abi.decode(SSTORE2.read(p), (string[]));
    }

    function getAIConfig(bytes32 id) external view returns (AIConfig memory) {
        return _ai[id];
    }

    function getUMAConfig(bytes32 id) external view returns (UMAConfig memory) {
        return _uma[id];
    }

    function getQuestion(bytes32 id) external view returns (string memory) {
        return _readText(_cores[id].questionPtr);
    }

    function getRules(bytes32 id) external view returns (string memory) {
        return _readText(_cores[id].rulesPtr);
    }

    function getClaimTemplate(bytes32 id) external view returns (string memory) {
        return _readText(_uma[id].claimTemplatePtr);
    }

    /// @notice §14.2 lower bound on `voidSecs` under the current globals (`createMarket` rule 2).
    function minVoidSecs(bool hasFeed, uint32 l1TimeoutSecs, uint32 l2DeadlineSecs, uint64 livenessReviewed)
        external
        view
        returns (uint256)
    {
        return _minVoidSecs(globalsAt(globalsVersion), hasFeed, l1TimeoutSecs, l2DeadlineSecs, livenessReviewed);
    }

    // ------------------------------------------------------------------ createMarket rules 1-6 (§6.3)

    /// @dev Rules 1-6 of `createMarket`, in order; each rule reverts with its first failing C.4 code.
    ///      Rule 1 records a new group's `GroupInfo` (createMarket is atomic, so a later revert undoes it).
    ///      Validates against the current globals version and returns it, with the minimum bond of the
    ///      active trust set's venue (both used again by steps 7-9).
    function _validateMarket(MarketInput calldata m) internal returns (Globals memory g, uint256 venueMin) {
        // Rule 1: identity.
        if (m.marketId == 0 || _cores[m.marketId].engine != address(0)) revert DuplicateMarket();
        uint32 setId = IResolutionOracle(oracle).activeTrustSetId();
        if (setId == 0) revert NoActiveTrustSet();
        if (m.groupId != 0) _recordGroup(m.groupId, m.groupExclusive);
        g = globalsAt(globalsVersion);

        uint8 code = _timesCode(m, g); // rule 2
        if (code != 0) revert BadTimes(code);
        code = _feedCode(m, g); // rule 3
        if (code != 0) revert BadFeed(code);
        code = _allowListCode(m.allowList); // rule 4
        if (code != 0) revert BadAllowList(code);
        code = _aiCode(m.ai, g); // rule 5
        if (code != 0) revert BadAIConfig(code);
        venueMin = IAssertionVenue(IResolutionOracle(oracle).trustSet(setId).cfg.venue).minimumBond();
        code = _umaCode(m, g, venueMin); // rule 6
        if (code != 0) revert BadUMAConfig(code);
    }

    /// @dev Groups ship with the oracle's group code (O14.6). Until then every grouped listing reverts
    ///      (plan §13.1 cut): a listing must not promise a YES lock the oracle does not enforce yet.
    function _groupsEnabled() internal view virtual returns (bool) {
        return false;
    }

    /// @dev The first market of a group records `{exists, exclusive}`; later ones must match it.
    function _recordGroup(bytes32 groupId, bool exclusive) internal {
        if (!_groupsEnabled()) revert EarlyCheckOrGroupsDisabled();
        GroupInfo storage gi = _groups[groupId];
        if (!gi.exists) {
            (gi.exists, gi.exclusive) = (true, exclusive);
        } else if (gi.exclusive != exclusive) {
            revert GroupMismatch();
        }
    }

    /// @dev BadTimes: 1 horizon, 2 window, 3 l2 bounds, 4 voidSecs < bound, 5 voidSecs > max,
    ///      6 engine gate `T + captureGraceSecs ≤ listedAt + voidSecs` (listedAt = now).
    function _timesCode(MarketInput calldata m, Globals memory g) internal view returns (uint8) {
        uint256 nowTs = block.timestamp;
        if (m.tau < nowTs + g.minHorizonSecs || m.tau > nowTs + g.maxListingHorizon) return 1;
        if (m.windowStart >= m.windowEnd || m.windowEnd > m.tau) return 2;
        if (m.l2DeadlineSecs < g.l2MinSecs || m.l2DeadlineSecs > g.l2MaxSecs) return 3;
        uint256 bound = _minVoidSecs(g, m.hasFeed, m.feed.l1TimeoutSecs, m.l2DeadlineSecs, m.uma.livenessReviewed);
        if (m.voidSecs < bound) return 4;
        if (m.voidSecs > g.maxVoidSecs) return 5;
        if (m.voidSecs < m.tau - nowTs + OracleConst.ENGINE_CAPTURE_GRACE_SECS) return 6;
        return 0;
    }

    /// @dev BadFeed 1-12 through FeedSpecLib (Layer 1 host = `allowList[0]`, or "" when the list is empty,
    ///      which fails code 5); without a feed the spec must be all-zero (13).
    function _feedCode(MarketInput calldata m, Globals memory g) internal view returns (uint8) {
        if (!m.hasFeed) return FeedSpecLib.isZero(m.feed) ? 0 : 13;
        string memory l1Host = m.allowList.length > 0 ? m.allowList[0] : "";
        bool known = m.feed.authRef == 0 || authRefKnown[m.feed.authRef];
        FeedSpecLib.TimingBounds memory b =
            FeedSpecLib.TimingBounds(g.bufferMinSecs, g.bufferMaxSecs, g.l1TimeoutMinSecs, g.l1TimeoutMaxSecs);
        return FeedSpecLib.validate(m.feed, l1Host, known, b);
    }

    /// @dev BadAllowList: 1 empty, 2 a host breaks the HostLib rules, 3 a host is not an allowed provider.
    ///      Codes in order: every host is checked for 2 before any is checked for 3.
    function _allowListCode(string[] calldata hosts) internal view returns (uint8) {
        if (hosts.length == 0) return 1;
        for (uint256 i; i < hosts.length; ++i) {
            if (!HostLib.isValidHost(hosts[i])) return 2;
        }
        for (uint256 i; i < hosts.length; ++i) {
            if (!_providerAllowed[keccak256(bytes(hosts[i]))]) return 3;
        }
        return 0;
    }

    /// @dev BadAIConfig: 1 model hashes (three, distinct, non-zero), 2 prompt, 3 calibrator, 4 category,
    ///      5 `highConfBps` outside `[highConfFloorBps, 10 000]`.
    function _aiCode(AIConfig calldata ai, Globals memory g) internal pure returns (uint8) {
        bytes32[3] calldata h = ai.modelIdHashes;
        if (h[0] == 0 || h[1] == 0 || h[2] == 0 || h[0] == h[1] || h[0] == h[2] || h[1] == h[2]) return 1;
        if (ai.promptHash == 0) return 2;
        if (ai.calibratorHash == 0) return 3;
        if (ai.categoryId == 0) return 4;
        if (ai.highConfBps < g.highConfFloorBps || ai.highConfBps > OracleConst.BPS) return 5;
        return 0;
    }

    /// @dev BadUMAConfig: 1 currency, 2 minBond below the venue minimum, 3 bondBps below the floor,
    ///      4 liveness (each ≥ tMinSecs, reviewed ≥ max(L1, auto)), 5 template tokens, 6 worst-case claim
    ///      length above `maxClaimBytes` (§6.3 rule 6, with the substituted Layer 1 URL for feed markets).
    function _umaCode(MarketInput calldata m, Globals memory g, uint256 venueMin) internal view returns (uint8) {
        UMAConfig calldata u = m.uma;
        if (u.bondCurrency != usdc) return 1;
        if (u.minBond < venueMin) return 2;
        if (u.bondBps < g.bondBpsFloor) return 3;
        if (
            u.livenessL1 < g.tMinSecs || u.livenessAuto < g.tMinSecs || u.livenessReviewed < g.tMinSecs
                || u.livenessReviewed < u.livenessL1 || u.livenessReviewed < u.livenessAuto
        ) return 4;
        if (!ClaimRenderer.isValidTemplate(m.claimTemplate)) return 5;
        uint256 l1UrlLen = m.hasFeed ? bytes(HostLib.substitute(m.feed.urlTemplate, m.feed.urlParam)).length : 0;
        uint256 maxLen =
            ClaimRenderer.worstCaseLength(m.claimTemplate, bytes(m.question).length, bytes(m.rules).length, l1UrlLen);
        if (maxLen > g.maxClaimBytes) return 6;
        return 0;
    }

    // ------------------------------------------------------------------ createMarket steps 8-9 (§6.3)

    /// @dev Step 8: the registry overwrites the seam fields of the pack's listing (seam decision S-07),
    ///      deploys through the factory, then requires `listingHash() == keccak256(abi.encode(listing))`
    ///      (the engine's own formula) and an unhalted engine.
    function _deployEngine(
        MarketInput calldata m,
        IMarketConfig.Listing calldata engineListing,
        bytes calldata engineInit,
        bytes32 specHash
    ) internal returns (address engine) {
        IMarketConfig.Listing memory l = engineListing;
        l.marketId = m.marketId;
        l.registry = address(this);
        l.resolutionAuthority = oracle;
        l.monitor = m.monitor;
        l.scheduledT = m.tau;
        l.listedAt = uint64(block.timestamp);
        l.rulesHash = keccak256(bytes(m.rules));
        l.sourceHash = keccak256(abi.encode(specHash, keccak256(abi.encode(m.allowList))));
        l.invalidRule = IMarketConfig.InvalidRule({
            fallbackListed: true,
            captureGraceSecs: OracleConst.ENGINE_CAPTURE_GRACE_SECS,
            fallbackPriceWad: OracleConst.ENGINE_FALLBACK_PRICE_WAD,
            voidSecs: m.voidSecs
        });
        engine = IMarketFactory(factory).deployMarket(l, engineInit);
        if (IMarketConfig(engine).listingHash() != keccak256(abi.encode(l))) revert ListingHashMismatch();
        if (IResolutionEngine(engine).getHaltSnapshot().halted) revert EngineAlreadyHalted();
    }

    /// @dev Step 9: long text to SSTORE2 (question, rules, allow-list in `AIConfig.allowListPtr`, claim
    ///      template in `UMAConfig.claimTemplatePtr`; the input pointers are ignored), then the structs.
    ///      `retryWindowSecs` and `earlyTtlSecs` are copied from the globals version used for validation.
    function _store(MarketInput calldata m, Globals memory g, address engine, bytes32 specHash) internal {
        bytes32 id = m.marketId;
        MarketCore storage c = _cores[id];
        c.engine = engine;
        c.questionPtr = _writeText(m.question);
        c.rulesPtr = _writeText(m.rules);
        c.listedAt = uint64(block.timestamp);
        c.windowStart = m.windowStart;
        c.windowEnd = m.windowEnd;
        c.tau = m.tau;
        c.groupId = m.groupId;
        c.groupExclusive = m.groupExclusive;
        c.hasFeed = m.hasFeed;
        c.l2DeadlineSecs = m.l2DeadlineSecs;
        c.voidSecs = m.voidSecs;
        c.retryWindowSecs = g.retryWindowSecs;
        c.earlyTtlSecs = g.earlyTtlSecs;
        c.monitor = m.monitor;
        c.oiCapLots = m.oiCapLots;
        c.rulesHash = keccak256(bytes(m.rules));
        c.specHash = specHash;
        c.gateHash = keccak256(abi.encode(m.ai.modelIdHashes, m.ai.promptHash, m.ai.calibratorHash, m.ai.highConfBps));
        _feeds[id] = m.feed;
        AIConfig memory ai = m.ai;
        ai.allowListPtr = SSTORE2.write(abi.encode(m.allowList));
        _ai[id] = ai;
        UMAConfig memory u = m.uma;
        u.claimTemplatePtr = _writeText(m.claimTemplate);
        _uma[id] = u;
    }

    /// @dev `umaConfigHash = keccak256(abi.encode(UMAConfig))` as stored, pointer included (ADJ-14).
    function _emitListed(MarketInput calldata m) internal {
        MarketCore storage c = _cores[m.marketId];
        emit MarketListed(
            m.marketId,
            c.engine,
            c.tau,
            c.hasFeed,
            c.groupId,
            c.rulesHash,
            c.specHash,
            c.gateHash,
            keccak256(abi.encode(_uma[m.marketId])),
            m.dryRunHash,
            m.ambiguityLogHash
        );
    }

    function _minVoidSecs(
        Globals memory g,
        bool hasFeed,
        uint32 l1TimeoutSecs,
        uint32 l2DeadlineSecs,
        uint64 livenessReviewed
    ) internal pure returns (uint256) {
        return VoidBound.minVoidSecs(
            VoidBound.Inputs({
                hasFeed: hasFeed,
                l1TimeoutSecs: l1TimeoutSecs,
                l2DeadlineSecs: l2DeadlineSecs,
                livenessReviewed: livenessReviewed,
                dvmMaxRolls: g.dvmMaxRolls,
                dvmRoundSecs: g.dvmRoundSecs,
                reviewTargetSecs: g.reviewTargetSecs,
                retryWindowSecs: g.retryWindowSecs,
                voidSlackSecs: g.voidSlackSecs
            })
        );
    }

    // ------------------------------------------------------------------ internals

    /// @dev First failing §14.4 rule (codes in the contract NatSpec), or 0.
    function _globalsCode(Globals calldata g, bool mainnet) internal pure returns (uint8) {
        if (
            g.minHorizonSecs < MIN_SECS || g.minHorizonSecs > g.maxListingHorizon
                || g.maxListingHorizon > MAX_LISTING_HORIZON || (mainnet && g.minHorizonSecs < MAINNET_MIN_HORIZON)
        ) return 1;
        if (!_pair(g.l2MinSecs, g.l2MaxSecs) || (mainnet && g.l2MinSecs < MAINNET_L2_MIN)) return 2;
        if (!_pair(g.bufferMinSecs, g.bufferMaxSecs)) return 3;
        if (!_pair(g.l1TimeoutMinSecs, g.l1TimeoutMaxSecs)) return 4;
        if (g.maxVoidSecs > MAX_VOID_SECS) return 5;
        if (g.tMinSecs < (mainnet ? MAINNET_T_MIN : MIN_SECS)) return 6;
        if (g.bondBpsFloor < (mainnet ? MAINNET_BOND_BPS_FLOOR : 1)) return 7;
        if (g.highConfFloorBps < (mainnet ? MAINNET_HIGH_CONF_FLOOR : HIGH_CONF_FLOOR)) return 8;
        if (g.maxClaimBytes > MAX_CLAIM_BYTES) return 9;
        if (mainnet && (g.dvmRoundSecs < MAINNET_DVM_ROUND || g.dvmMaxRolls < MAINNET_DVM_ROLLS)) return 10;
        if (mainnet && (g.reviewTargetSecs < MAINNET_REVIEW_TARGET || g.voidSlackSecs < MAINNET_VOID_SLACK)) {
            return 11;
        }
        if (g.retryWindowSecs < (mainnet ? MAINNET_RETRY_WINDOW : MIN_SECS)) return 12;
        if (g.earlyTtlSecs < (mainnet ? MAINNET_EARLY_TTL : MIN_SECS) || g.earlyTtlSecs > MAX_EARLY_TTL) return 13;
        if (g.minRequestIntervalSecs < MIN_SECS || g.minRequestIntervalSecs > MAX_REQUEST_INTERVAL) return 14;
        if (g.heartbeatMaxAgeSecs < MIN_HEARTBEAT_AGE || g.heartbeatMaxAgeSecs > MAX_HEARTBEAT_AGE) return 15;
        if (g.deltaPmaxBps > MAX_DELTA_PMAX_BPS || g.nMin < (mainnet ? MAINNET_N_MIN : 1)) return 16;
        if (g.proposerRewardAtoms > MAX_PROPOSER_REWARD) return 17;
        return 0;
    }

    /// @dev `MIN_SECS ≤ min ≤ max`.
    function _pair(uint32 min, uint32 max) private pure returns (bool) {
        return min >= MIN_SECS && min <= max;
    }

    /// @dev Long text (question, rules, allow-list, claim template) lives in SSTORE2 data contracts.
    function _writeText(string memory s) internal returns (address) {
        return SSTORE2.write(bytes(s));
    }

    /// @dev Pointer 0 reads as empty (SSTORE2.read of a codeless address would underflow its length).
    function _readText(address pointer) internal view returns (string memory) {
        if (pointer == address(0)) return "";
        return string(SSTORE2.read(pointer));
    }
}
