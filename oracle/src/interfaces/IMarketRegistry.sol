// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IMarketConfig} from "@eros/interfaces/IMarketConfig.sol";
import {
    MarketCore,
    MarketInput,
    FeedSpec,
    AIConfig,
    UMAConfig,
    Globals,
    Category,
    GroupInfo
} from "../types/OracleTypes.sol";

interface IMarketRegistry {
    error Unauthorized();
    error DuplicateMarket();
    error BadTimes(uint8 code); // 1 horizon, 2 window, 3 l2 bounds, 4 voidSecs < bound, 5 voidSecs > max, 6 engine gate
    error BadFeed(uint8 code); // 1 https, 2 host, 3 {id}, 4 urlParam, 5 L1 host != allowList[0], 6 path, 7 finalValue,
    // 8 op/type, 9 decimals, 10 target, 11 buffer/timeout, 12 authRef, 13 non-zero spec without feed
    error BadAllowList(uint8 code); // 1 empty, 2 bad host, 3 provider not allowed
    error BadAIConfig(uint8 code); // 1 model hashes, 2 prompt, 3 calibrator, 4 category, 5 highConfBps
    error BadUMAConfig(uint8 code); // 1 currency, 2 minBond, 3 bondBps, 4 liveness, 5 template tokens, 6 claim too long
    error GroupMismatch();
    error NoActiveTrustSet();
    error ListingHashMismatch();
    error EngineAlreadyHalted();
    error BadGlobals(uint8 code);
    error NoFactory(); // factory unset (mainnet, until the Timelock calls setFactory)
    error EarlyCheckOrGroupsDisabled(); // hackathon cut only

    event MarketListed(
        bytes32 indexed id,
        address indexed engine,
        uint64 tau,
        bool hasFeed,
        bytes32 indexed groupId,
        bytes32 rulesHash,
        bytes32 specHash,
        bytes32 gateHash,
        bytes32 umaConfigHash,
        bytes32 dryRunHash,
        bytes32 ambiguityLogHash
    );
    event ProviderSet(string host, bool allowed);
    event AuthRefSet(bytes32 indexed authRef, bool known);
    event CategorySet(bytes32 indexed categoryId, bytes32 gateHash, uint16 u95Bps, uint32 sampleN, bool validated);
    event GlobalsSet(uint32 indexed version, bytes32 globalsHash);
    event ListerSet(address lister);
    event FactorySet(address factory);

    /// @notice Lister only. Validates everything (plan §6.3), deploys the engine through the factory,
    ///         checks the handshake, commits the treasury bond at the OI cap, and initializes the Resolution.
    function createMarket(
        MarketInput calldata m,
        IMarketConfig.Listing calldata engineListing,
        bytes calldata engineInit
    ) external returns (address engine);

    // governance (Timelock)
    function setProvider(string calldata host, bool allowed) external;
    function setAuthRef(bytes32 authRef, bool known) external;
    function setCategory(bytes32 categoryId, bytes32 gateHash, uint16 u95Bps, uint32 sampleN, bool validated) external;
    function setGlobals(Globals calldata g) external;
    function setLister(address lister) external;
    function setFactory(address factory) external;

    // views
    function getMarketCore(bytes32 id) external view returns (MarketCore memory);
    function getFeedSpec(bytes32 id) external view returns (FeedSpec memory);
    function getSpecHash(bytes32 id) external view returns (bytes32);
    function getAllowList(bytes32 id) external view returns (string[] memory);
    function getAIConfig(bytes32 id) external view returns (AIConfig memory);
    function getUMAConfig(bytes32 id) external view returns (UMAConfig memory);
    function getQuestion(bytes32 id) external view returns (string memory);
    function getRules(bytes32 id) external view returns (string memory);
    function getClaimTemplate(bytes32 id) external view returns (string memory);
    function isListed(bytes32 id) external view returns (bool);
    function category(bytes32 categoryId) external view returns (Category memory);
    function groupInfo(bytes32 groupId) external view returns (GroupInfo memory);
    function globals() external view returns (Globals memory); // current version
    function globalsVersion() external view returns (uint32);
    function globalsAt(uint32 version) external view returns (Globals memory); // every version is kept
    function providerAllowed(string calldata host) external view returns (bool);
    function authRefKnown(bytes32 authRef) external view returns (bool);
    function minVoidSecs(bool hasFeed, uint32 l1TimeoutSecs, uint32 l2DeadlineSecs, uint64 livenessReviewed)
        external
        view
        returns (uint256);
    function lister() external view returns (address);
    function factory() external view returns (address);
    function oracle() external view returns (address);
    function treasury() external view returns (address);
    function usdc() external view returns (address);
    function governance() external view returns (address);
}
