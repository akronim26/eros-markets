// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {FinalizeStatus} from "./types/OracleTypes.sol";
import {IKeeperRouter} from "./interfaces/IKeeperRouter.sol";
import {IResolutionOracle} from "./interfaces/IResolutionOracle.sol";

/// @title KeeperRouter
/// @notice Stateless batching helper for the keeper (plan §6.11, Appendix C.6). Every inner call goes to the
///         oracle's permissionless entry points inside try/catch, so one market's revert (an engine that
///         refuses `settle`, an unfunded treasury, an unknown id) never blocks the others.
/// @dev Holds no funds, no approvals and no state beyond the oracle's address, and has no privilege: the
///      oracle treats it like any caller, and keepers can always call the oracle directly instead.
contract KeeperRouter is IKeeperRouter {
    /// @notice A constructor address that must be set is zero (deploy-script mistake).
    error ZeroAddress();

    IResolutionOracle public immutable oracle;

    constructor(address oracle_) {
        if (oracle_ == address(0)) revert ZeroAddress();
        oracle = IResolutionOracle(oracle_);
    }

    /// @notice `finalizeMarket` for each id. A reverted call reports `reverted[i] = true` and NOT_READY.
    function finalizeMany(bytes32[] calldata ids)
        external
        returns (FinalizeStatus[] memory statuses, bool[] memory reverted)
    {
        uint256 n = ids.length;
        statuses = new FinalizeStatus[](n);
        reverted = new bool[](n);
        for (uint256 i; i < n; ++i) {
            try oracle.finalizeMarket(ids[i]) returns (FinalizeStatus s) {
                statuses[i] = s;
            } catch {
                reverted[i] = true;
            }
        }
    }

    /// @notice `assertProposal` for each id; a reverted call (MaxAttempts, TreasuryShort, ...) is false.
    function assertMany(bytes32[] calldata ids) external returns (bool[] memory asserted) {
        uint256 n = ids.length;
        asserted = new bool[](n);
        for (uint256 i; i < n; ++i) {
            try oracle.assertProposal(ids[i]) returns (bool ok) {
                asserted[i] = ok;
            } catch {}
        }
    }

    /// @notice `haltScheduled` then `requestResolution`, each in its own try/catch: a `TooEarly` or `NoFeed`
    ///         revert of the request never undoes the halt. Returns what each call reported (false if it
    ///         reverted or had nothing to do).
    function haltAndRequest(bytes32 id) external returns (bool halted, bool requested) {
        try oracle.haltScheduled(id) returns (bool changed) {
            halted = changed;
        } catch {}
        try oracle.requestResolution(id) returns (bool emitted) {
            requested = emitted;
        } catch {}
    }
}
