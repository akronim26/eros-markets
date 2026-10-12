// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

/// @notice ABI mirror of the oracle team's `MarketCore` (oracle/src/types/OracleTypes.sol). Every
///         field is static, so the return data is a flat tuple; field order must match exactly.
///         The oracle integration test binds a vault to a real registry to pin this layout.
struct RegistryMarketCore {
    address engine;
    address questionPtr;
    address rulesPtr;
    uint64 listedAt;
    uint64 windowStart;
    uint64 windowEnd;
    uint64 tau;
    bytes32 groupId;
    bool groupExclusive;
    bool hasFeed;
    uint32 l2DeadlineSecs;
    uint32 voidSecs;
    uint32 retryWindowSecs;
    uint32 earlyTtlSecs;
    address monitor;
    uint256 oiCapLots;
    bytes32 rulesHash;
    bytes32 specHash;
    bytes32 gateHash;
}

/// @notice The one MarketRegistry read a native vault needs to find the registry-selected engine.
interface INativeRegistryReads {
    function getMarketCore(bytes32 id) external view returns (RegistryMarketCore memory);
}
