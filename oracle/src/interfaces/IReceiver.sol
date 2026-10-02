// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

interface IERC165 {
    function supportsInterface(bytes4 interfaceId) external view returns (bool);
}

/// @notice Chainlink CRE consumer interface. KeystoneForwarder calls onReport(metadata, report).
///         type(IReceiver).interfaceId == 0x805f2132.
interface IReceiver is IERC165 {
    function onReport(bytes calldata metadata, bytes calldata report) external;
}
