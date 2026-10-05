// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Resolution, GroupState} from "../../src/types/OracleTypes.sol";
import {ResolutionOracle} from "../../src/ResolutionOracle.sol";

/// @title ResolutionOracleHarness
/// @notice Test-only ResolutionOracle that can place a market's Resolution (and its group state and
///         evidence URI) in any state (task O14.1), so each transition can be tested from its own
///         starting state. Never deployed.
contract ResolutionOracleHarness is ResolutionOracle {
    constructor(
        address registry_,
        address treasury_,
        address usdc_,
        uint64 monadChainSelector_,
        address governance_,
        address guardian_
    ) ResolutionOracle(registry_, treasury_, usdc_, monadChainSelector_, governance_, guardian_) {}

    /// @notice Marks the market initialized and overwrites its whole Resolution.
    function setResolution(bytes32 id, Resolution memory r) external {
        _initialized[id] = true;
        _res[id] = r;
    }

    function setGroupState(bytes32 groupId, GroupState memory g) external {
        _groups[groupId] = g;
    }

    /// @notice Clears or overrides the active trust set (unreachable through governance once set).
    function setActiveTrustSetId(uint32 setId) external {
        activeTrustSetId = setId;
    }

    function setEvidenceURI(bytes32 id, string memory uri) external {
        _evidenceURI[id] = uri;
    }
}
