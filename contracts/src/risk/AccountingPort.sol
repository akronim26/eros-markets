// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;
import {Accounting} from "./Accounting.sol";

/// @notice B implements these internal decision/context ports at composition time.
/// @dev No production mock, external pricing call or public arbitrary posting method.
abstract contract AccountingPort is Accounting {
    function _riskContext() internal view virtual returns (Context memory);
    function _riskAccept(Decision memory decision) internal view virtual returns (bool);

    function _checkedContext() internal view returns (Context memory c) {
        c = _riskContext();
        if (c.at != _clock() || c.version == 0) revert Stale();
    }

    function _requireDecision(Decision memory d) internal view {
        if (!_riskAccept(d)) revert Rejected();
    }

    function _validateContext(Context memory c) internal view {
        if (keccak256(abi.encode(c)) != keccak256(abi.encode(_checkedContext()))) revert Stale();
    }
}
