// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Resolution, TrustSet} from "../../src/types/OracleTypes.sol";

/// @title MockOracleView
/// @notice Stands in for `ResolutionOracle` in registry and treasury tests (task O11.1): a scripted
///         active trust set, `getResolution` and `watchdogOf`, and a recorder for `initResolution`.
contract MockOracleView {
    error AlreadyInitialized();

    uint32 public activeTrustSetId;
    mapping(uint32 => TrustSet) internal _sets;
    mapping(bytes32 => Resolution) internal _res;
    mapping(bytes32 => address) public watchdogOf;
    mapping(bytes32 => bool) public initialized;
    bytes32[] public initCalls;

    function setTrustSet(uint32 id, TrustSet memory t, bool active) external {
        _sets[id].cfg.forwarder = t.cfg.forwarder;
        _sets[id].cfg.production = t.cfg.production;
        _sets[id].cfg.workflowIds = t.cfg.workflowIds;
        _sets[id].cfg.workflowOwner = t.cfg.workflowOwner;
        _sets[id].cfg.workflowName = t.cfg.workflowName;
        _sets[id].cfg.runnerAttestor = t.cfg.runnerAttestor;
        _sets[id].cfg.committee = t.cfg.committee;
        _sets[id].cfg.threshold = t.cfg.threshold;
        _sets[id].cfg.watchdog = t.cfg.watchdog;
        _sets[id].cfg.venue = t.cfg.venue;
        _sets[id].workflowIdRevoked = t.workflowIdRevoked;
        _sets[id].attestorRevoked = t.attestorRevoked;
        _sets[id].watchdogRevoked = t.watchdogRevoked;
        _sets[id].createdAt = t.createdAt;
        if (active) activeTrustSetId = id;
    }

    function setActiveTrustSetId(uint32 id) external {
        activeTrustSetId = id;
    }

    function setResolution(bytes32 id, Resolution memory r) external {
        _res[id] = r;
    }

    function setWatchdog(bytes32 id, address w) external {
        watchdogOf[id] = w;
    }

    function trustSet(uint32 id) external view returns (TrustSet memory) {
        return _sets[id];
    }

    function getResolution(bytes32 id) external view returns (Resolution memory) {
        return _res[id];
    }

    function initResolution(bytes32 id) external {
        if (initialized[id]) revert AlreadyInitialized();
        initialized[id] = true;
        initCalls.push(id);
    }

    function initCount() external view returns (uint256) {
        return initCalls.length;
    }
}
