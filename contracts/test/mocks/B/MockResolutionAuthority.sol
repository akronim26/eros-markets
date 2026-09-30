// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IResolutionEngine, HaltView, OracleOutcomeMap} from "../../../src/interfaces/IResolutionIngress.sol";

/// @title MockResolutionAuthority (B020)
/// @notice Deterministic stand-in for the oracle team's ResolutionOracle (spec §8.6). Implements
///         only the authorized engine calls: early halt, late scheduled halt, final YES/NO/INVALID,
///         identical repeats, a conflicting attempt and delayed delivery with retry. No AI, CRE,
///         committee or UMA logic.
contract MockResolutionAuthority {
    IResolutionEngine public engine;
    bool public hasPending;
    uint8 public pendingOutcome; // oracle source enum value
    uint256 public deliveries;
    uint256 public failedDeliveries;
    bool public lastNewlyAccepted;

    event DeliveryAttempt(uint8 oracleOutcome, bool delivered, bool newlyAccepted);

    function bind(IResolutionEngine e) external {
        require(address(engine) == address(0), "bound");
        engine = e;
    }

    function haltEarly() external returns (HaltView memory) {
        return engine.halt();
    }

    function requestScheduledHalt() external returns (HaltView memory) {
        return engine.materializeScheduledHalt();
    }

    /// @notice Final outcome delivered in the same transaction; an engine revert rolls it back.
    function finalize(uint8 oracleOutcome) public returns (bool newlyAccepted) {
        (OracleOutcomeMap.EngineCall call, uint8 y) = OracleOutcomeMap.engineCallFor(oracleOutcome);
        newlyAccepted =
            call == OracleOutcomeMap.EngineCall.SETTLE_BINARY ? engine.settle(y) : engine.settleInvalid();
        lastNewlyAccepted = newlyAccepted;
        deliveries += 1;
    }

    /// @notice External finality stored first; delivery retried later without changing it.
    function storeExternalFinality(uint8 oracleOutcome) external {
        require(!hasPending, "pending");
        OracleOutcomeMap.engineCallFor(oracleOutcome); // validates the value
        (hasPending, pendingOutcome) = (true, oracleOutcome);
    }

    function retryDelivery() external returns (bool delivered) {
        require(hasPending, "nothing pending");
        try this.finalize(pendingOutcome) returns (bool n) {
            delivered = true;
            hasPending = false;
            emit DeliveryAttempt(pendingOutcome, true, n);
        } catch {
            failedDeliveries += 1;
            emit DeliveryAttempt(pendingOutcome, false, false);
        }
    }

    /// @notice Raw call with an arbitrary Y (tests the engine's Y validation).
    function rawSettle(uint8 y) external returns (bool) {
        return engine.settle(y);
    }
}
