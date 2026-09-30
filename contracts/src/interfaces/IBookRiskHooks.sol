// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Side, Stage, AdmissionMode, StepStatus, RejectCode} from "../../provisional/MathTypes.sol";

/// @title IBookRiskHooks
/// @notice CP-BOOK boundary, spec §7.2 and §7.5 verbatim: the internal hook set a per-market
///         engine's matcher calls, and the data it exchanges with Risk & Clearing. All calls are
///         internal (same contract); no external call, token transfer or callback in the loop.
/// @dev Structs are declared inside this contract so the spec's `RiskSnapshot` name does not
///      collide with the book team's `src/RiskSnapshot.sol` (see docs/counterpart-contracts.md).
///      Units: lots (uint64), ticks 1..999, Q (1e18 per atom), full uint64 epochs.
abstract contract IBookRiskHooks {
    enum OrderKind {
        LIMIT,
        IOC,
        POST_ONLY
    }

    struct OrderKey {
        uint32 slot;
        uint24 generation;
    }

    struct EpochTag {
        uint64 marketOrderEpoch;
        uint64 accountOrderEpoch;
    }

    struct OrderView {
        OrderKey key;
        uint32 owner;
        Side side;
        uint16 tick;
        uint64 remainingLots;
        uint32 expiryBlock; // zero = no expiry; executable while block.number <= expiryBlock
        EpochTag admittedAt;
        bool reduceOnly;
        uint64 reduceVersion;
        uint256 remainingFeeCapQ;
    }

    struct OrderRequest {
        uint32 trader;
        Side side;
        OrderKind kind;
        uint16 limitTick;
        uint64 requestedLots;
        uint32 expiryBlock;
        bool reduceOnly;
        uint16 maxSteps; // maximum examined makers
    }

    struct RiskSnapshot {
        uint64 marketOrderEpoch;
        uint64 riskVersion;
        uint64 economicTime;
        Stage stage;
        uint256 indexWad;
        uint256 markWad;
        int256 fundingIndex;
        uint64 accountingEpochId;
        uint64 premiumCutoff;
        bytes32 premiumTariffHash;
        uint64 feeVersion;
        uint64 parameterVersion;
    }

    struct TakerPermit {
        uint64 localPermitId;
        uint32 trader;
        Side side;
        uint16 limitTick;
        uint64 remainingLots;
        uint256 remainingFeeCapQ;
        uint64 reduceVersion;
        bool reduceOnly;
        AdmissionMode mode;
    }

    struct StepResult {
        StepStatus status;
        RejectCode reason;
        uint64 filledLots;
        uint256 notionalQ;
        uint256 makerFeeQ;
        uint256 takerFeeQ;
        uint64 makerRemainingLots;
        bool removeMakerRemainder;
    }

    function _riskBeginAction() internal virtual returns (RiskSnapshot memory snap);

    function _riskTouchAccount(uint32 trader, RiskSnapshot memory snap) internal virtual;

    function _riskPrepareTaker(OrderRequest memory req, RiskSnapshot memory snap, AdmissionMode mode)
        internal
        virtual
        returns (TakerPermit memory permit, RejectCode rejection);

    function _riskTryMatchedFill(
        RiskSnapshot memory snap,
        TakerPermit memory permit,
        OrderView memory maker,
        uint64 proposedLots
    ) internal virtual returns (StepResult memory result);

    function _riskAdmitRest(
        RiskSnapshot memory snap,
        uint32 owner,
        Side side,
        uint16 tick,
        uint64 lots,
        uint32 expiryBlock,
        bool reduceOnly
    ) internal virtual returns (EpochTag memory tag, uint64 reduceVersion, uint256 feeCapQ);

    function _riskConvertPermitToRest(
        RiskSnapshot memory snap,
        TakerPermit memory permit,
        uint64 lotsToRest,
        uint32 expiryBlock
    ) internal virtual returns (EpochTag memory tag, uint64 reduceVersion, uint256 feeCapQ);

    function _riskOnUnrest(
        RiskSnapshot memory snap,
        uint32 owner,
        EpochTag memory admittedAt,
        Side side,
        uint16 tick,
        uint64 removedLots,
        uint256 releasedFeeCapQ
    ) internal virtual;

    function _riskCancelAll(uint32 trader) internal virtual returns (EpochTag memory newTag);

    function _riskFinishTaker(RiskSnapshot memory snap, TakerPermit memory permit) internal virtual;
}
