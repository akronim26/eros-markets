// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IERC165, IReceiver} from "../../src/interfaces/IReceiver.sol";

/// @title MockKeystoneForwarderLite
/// @notice Header-faithful stand-in for Chainlink's KeystoneForwarder (plan §7.1, §11.1, V-C7, V-C8;
///         task O15.1). It builds the raw report exactly as the DON does, a 109-byte header followed by the
///         workflow payload, and delivers it the way the forwarder routes it: an ERC-165 receiver check,
///         then `onReport(rawReport[45:109], rawReport[109:])` in a low-level call whose revert is recorded
///         rather than bubbled. No DON signatures are checked: it is a test double, never deployed.
/// @dev Header layout (offsets in bytes): version [0], workflowExecutionId [1:33], timestamp [33:37],
///      donId [37:41], donConfigVersion [41:45], workflowId [45:77], workflowName [77:87],
///      workflowOwner [87:107], reportId [107:109]. The 64-byte metadata the receiver gets is
///      workflowId ‖ workflowName ‖ workflowOwner ‖ reportId. Transmission rule (V-C8): a success or an
///      invalid receiver ends the transmission; a reverted `onReport` leaves it retryable.
contract MockKeystoneForwarderLite {
    error AlreadyAttempted(bytes32 transmissionId);
    error ShortReport();

    uint256 internal constant HEADER_BYTES = 109;
    uint256 internal constant METADATA_START = 45;

    enum TransmissionState {
        NOT_ATTEMPTED,
        SUCCEEDED,
        INVALID_RECEIVER,
        FAILED
    }

    struct Header {
        bytes32 executionId;
        uint32 timestamp;
        uint32 donId;
        uint32 donConfigVersion;
        bytes32 workflowId;
        bytes10 workflowName;
        address workflowOwner;
        bytes2 reportId;
    }

    event ReportProcessed(
        address indexed receiver, bytes32 indexed workflowExecutionId, bytes2 indexed reportId, bool result
    );

    mapping(bytes32 transmissionId => TransmissionState) public transmissionState;

    /// @notice The raw report the DON signs: version 1 header, then the workflow's payload.
    function rawReport(Header memory h, bytes memory payload) public pure returns (bytes memory) {
        return abi.encodePacked(
            uint8(1),
            h.executionId,
            h.timestamp,
            h.donId,
            h.donConfigVersion,
            h.workflowId,
            h.workflowName,
            h.workflowOwner,
            h.reportId,
            payload
        );
    }

    /// @notice The metadata the receiver gets for this header (`rawReport[45:109]`).
    function metadataOf(Header memory h) external pure returns (bytes memory) {
        return abi.encodePacked(h.workflowId, h.workflowName, h.workflowOwner, h.reportId);
    }

    function transmissionId(address receiver, bytes32 executionId, bytes2 reportId) public pure returns (bytes32) {
        return keccak256(abi.encode(receiver, executionId, reportId));
    }

    /// @notice Anyone (the DON transmitter). Routes the report and returns whether `onReport` succeeded.
    function report(address receiver, bytes calldata raw) external returns (bool result) {
        if (raw.length < HEADER_BYTES) revert ShortReport();
        bytes32 executionId = bytes32(raw[1:33]);
        bytes2 reportId = bytes2(raw[107:109]);
        bytes32 tid = transmissionId(receiver, executionId, reportId);
        TransmissionState s = transmissionState[tid];
        if (s == TransmissionState.SUCCEEDED || s == TransmissionState.INVALID_RECEIVER) revert AlreadyAttempted(tid);
        if (!_supportsReceiver(receiver)) {
            transmissionState[tid] = TransmissionState.INVALID_RECEIVER;
            emit ReportProcessed(receiver, executionId, reportId, false);
            return false;
        }
        (result,) =
            receiver.call(abi.encodeCall(IReceiver.onReport, (raw[METADATA_START:HEADER_BYTES], raw[HEADER_BYTES:])));
        transmissionState[tid] = result ? TransmissionState.SUCCEEDED : TransmissionState.FAILED;
        emit ReportProcessed(receiver, executionId, reportId, result);
    }

    /// @dev ERC-165 detection as OpenZeppelin's ERC165Checker does it: supports ERC-165 itself, refuses
    ///      0xffffffff, then supports IReceiver.
    function _supportsReceiver(address receiver) internal view returns (bool) {
        return _query(receiver, type(IERC165).interfaceId) && !_query(receiver, 0xffffffff)
            && _query(receiver, type(IReceiver).interfaceId);
    }

    function _query(address target, bytes4 interfaceId) internal view returns (bool) {
        (bool ok, bytes memory ret) =
            target.staticcall{gas: 30_000}(abi.encodeCall(IERC165.supportsInterface, (interfaceId)));
        return ok && ret.length >= 32 && abi.decode(ret, (bool));
    }
}
