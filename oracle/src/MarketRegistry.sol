// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {SSTORE2} from "solady/utils/SSTORE2.sol";
import {Globals, Category, GroupInfo, OracleConst} from "./types/OracleTypes.sol";
import {IMarketRegistry} from "./interfaces/IMarketRegistry.sol";

/// @title MarketRegistry
/// @notice Immutable per-market resolution config and the bounded, versioned listing globals
///         (plan §6.3, §14.4, Appendix C.1, C.4). Not upgradeable; governance is the Timelock.
/// @dev Task O11.2 builds storage, globals and the governance setters; `createMarket`, the market views
///      and `minVoidSecs` follow in O11.3 and O11.4, which also declare `is IMarketRegistry`. Until then
///      errors and events are the C.4 declarations, used by qualified name.
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
contract MarketRegistry {
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

    modifier onlyGovernance() {
        if (msg.sender != governance) revert IMarketRegistry.Unauthorized();
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

    // ------------------------------------------------------------------ governance (Timelock)

    /// @notice Hosts every market's allow-list must come from (§6.3 rule 4).
    function setProvider(string calldata host, bool allowed) external onlyGovernance {
        _providerAllowed[keccak256(bytes(host))] = allowed;
        emit IMarketRegistry.ProviderSet(host, allowed);
    }

    /// @notice Auth references the workflow config can resolve (§6.3 rule 3, §7.4).
    function setAuthRef(bytes32 authRef, bool known) external onlyGovernance {
        authRefKnown[authRef] = known;
        emit IMarketRegistry.AuthRefSet(authRef, known);
    }

    /// @notice Every validated call stamps `validatedAt = now` (so changing a validated category restarts
    ///         its clock); an unvalidated call clears it (§6.3).
    function setCategory(bytes32 categoryId, bytes32 gateHash, uint16 u95Bps, uint32 sampleN, bool validated)
        external
        onlyGovernance
    {
        _categories[categoryId] =
            Category(gateHash, u95Bps, sampleN, validated, validated ? uint64(block.timestamp) : 0);
        emit IMarketRegistry.CategorySet(categoryId, gateHash, u95Bps, sampleN, validated);
    }

    /// @notice Appends a new globals version after checking every §14.4 bound.
    function setGlobals(Globals calldata g) external onlyGovernance {
        uint8 code = _globalsCode(g, block.chainid == OracleConst.MONAD_MAINNET_CHAIN_ID);
        if (code != 0) revert IMarketRegistry.BadGlobals(code);
        uint32 v = ++globalsVersion;
        _globals[v] = g;
        emit IMarketRegistry.GlobalsSet(v, keccak256(abi.encode(g)));
    }

    function setLister(address lister_) external onlyGovernance {
        lister = lister_;
        emit IMarketRegistry.ListerSet(lister_);
    }

    /// @notice Future listings only: listed markets store their own engine address.
    function setFactory(address factory_) external onlyGovernance {
        factory = factory_;
        emit IMarketRegistry.FactorySet(factory_);
    }

    // ------------------------------------------------------------------ views

    /// @notice The current globals version; reverts `BadGlobals(0)` before the first `setGlobals`.
    function globals() external view returns (Globals memory) {
        return globalsAt(globalsVersion);
    }

    /// @notice Any version ever set; reverts `BadGlobals(0)` for version 0 or one not set yet.
    function globalsAt(uint32 version) public view returns (Globals memory) {
        if (version == 0 || version > globalsVersion) revert IMarketRegistry.BadGlobals(0);
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
