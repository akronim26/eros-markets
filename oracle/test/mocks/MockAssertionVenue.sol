// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {SafeTransferLib} from "solady/utils/SafeTransferLib.sol";
import {IAssertionVenue} from "../../src/interfaces/IAssertionVenue.sol";

/// @title MockAssertionVenue
/// @notice Scripted `IAssertionVenue` (task O11.1). Nothing settles on its own: a test scripts each
///         assertion's result with `setResult`, marks disputes with `markDisputed`, settles behind the
///         oracle's back with `settleDirectly`, or leaves a dispute unanswered forever (the default).
///         With `token` set, bonds move like the real venue: pulled from the payer at assertion and
///         dispute, returned to the asserter when settled true.
contract MockAssertionVenue is IAssertionVenue {
    using SafeTransferLib for address;

    error UnknownAssertion();

    enum Result {
        UNANSWERED,
        TRUE,
        FALSE
    }

    struct Assertion {
        AssertRequest req;
        uint64 expiresAt;
        bool disputed;
        bool settled;
        bool truthful;
        address disputer;
        Result scripted;
    }

    address public token; // 0: no token transfers
    uint256 public minimumBondValue;
    uint256 public nonce;
    mapping(bytes32 => Assertion) internal _a;

    constructor(address token_, uint256 minimumBond_) {
        token = token_;
        minimumBondValue = minimumBond_;
    }

    // ------------------------------------------------------------------ knobs

    function setMinimumBond(uint256 v) external {
        minimumBondValue = v;
    }

    function setResult(bytes32 id, bool truthful) external {
        _a[id].scripted = truthful ? Result.TRUE : Result.FALSE;
    }

    function markDisputed(bytes32 id, address disputer) external {
        (_a[id].disputed, _a[id].disputer) = (true, disputer);
    }

    /// @notice Settles on the venue without going through `trySettle` (anyone can on OOv3).
    function settleDirectly(bytes32 id, bool truthful) external {
        _settle(id, truthful);
    }

    // ------------------------------------------------------------------ IAssertionVenue

    function assertOutcome(AssertRequest calldata req) external returns (bytes32 id) {
        id = keccak256(abi.encode(address(this), ++nonce, req.marketId));
        if (token != address(0)) token.safeTransferFrom(req.payer, address(this), req.bond);
        Assertion storage a = _a[id];
        a.req = req;
        a.expiresAt = uint64(block.timestamp) + req.liveness;
    }

    function trySettle(bytes32 id) external returns (bool settledNow) {
        Assertion storage a = _a[id];
        if (a.req.asserter == address(0) || a.settled || a.scripted == Result.UNANSWERED) return false;
        _settle(id, a.scripted == Result.TRUE);
        return true;
    }

    function disputeFor(bytes32 id, address payer, address disputer) external {
        Assertion storage a = _a[id];
        if (a.req.asserter == address(0)) revert UnknownAssertion();
        if (token != address(0)) token.safeTransferFrom(payer, address(this), a.req.bond);
        (a.disputed, a.disputer) = (true, disputer);
    }

    function statusOf(bytes32 id) external view returns (AssertionStatus memory s) {
        Assertion storage a = _a[id];
        s.exists = a.req.asserter != address(0);
        s.disputed = a.disputed;
        s.settled = a.settled;
        s.truthful = a.settled && a.truthful;
        s.expiresAt = a.expiresAt;
        s.asserter = a.req.asserter;
        s.disputer = a.disputer;
        s.bond = a.req.bond;
    }

    function marketOf(bytes32 id) external view returns (bytes32) {
        return _a[id].req.marketId;
    }

    function minimumBond() external view returns (uint256) {
        return minimumBondValue;
    }

    function bondCurrency() external view returns (address) {
        return token;
    }

    function claimOf(bytes32 id) external view returns (bytes memory) {
        return _a[id].req.claim;
    }

    function _settle(bytes32 id, bool truthful) internal {
        Assertion storage a = _a[id];
        if (a.req.asserter == address(0)) revert UnknownAssertion();
        (a.settled, a.truthful) = (true, truthful);
        if (truthful && token != address(0)) token.safeTransfer(a.req.asserter, a.req.bond);
    }
}
