// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;
import {RiskStorage} from "../../../src/risk/RiskStorage.sol";

/// @notice Scripted approvals only; deliberately contains no B economic implementation.
contract MockRiskDecision {
    mapping(address => bool) public allowed;
    mapping(address => bytes32) public expected;
    bool public rejectFees;

    function set(address owner, bool yes) external {
        allowed[owner] = yes;
    }

    function expect(address owner, bytes32 digest) external {
        expected[owner] = digest;
    }

    function setRejectFees(bool yes) external {
        rejectFees = yes;
    }

    function check(RiskStorage.Decision memory d) external view returns (bool) {
        return allowed[d.owner] && (!rejectFees || d.feesQ == 0)
            && (expected[d.owner] == bytes32(0) || expected[d.owner] == keccak256(abi.encode(d)));
    }
}
