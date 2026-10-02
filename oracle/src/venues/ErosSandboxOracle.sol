// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Ownable} from "solady/auth/Ownable.sol";

/// @title ErosSandboxOracle — TESTNET ONLY stand-in for UMA's DVM (Oracle spec §7.1).
/// @notice Same external surface OOv3 uses (requestPrice/hasPrice/getPrice), but ONLY the owner (the team
///         Safe) can answer. UMA's own MockOracleAncillary lets ANY address push prices, which on a public
///         testnet would let anyone decide every disputed market. Never deploy on mainnet.
contract ErosSandboxOracle is Ownable {
    error NotRequested();
    error NoPrice();
    error AlreadyAnswered();

    struct Request {
        bool requested;
        bool answered;
        int256 price;
        bytes32 identifier;
        uint256 time;
        bytes ancillaryData;
    }

    mapping(bytes32 requestId => Request) public requests;
    address public requester; // the sandbox OOv3, set once (OOv3's constructor needs this oracle first)

    event PriceRequested(bytes32 indexed requestId, bytes32 identifier, uint256 time, bytes ancillaryData);
    event PricePushed(bytes32 indexed requestId, int256 price);

    constructor(address owner_) {
        _initializeOwner(owner_);
    }

    function setRequester(address oov3_) external onlyOwner {
        if (requester != address(0)) revert AlreadyAnswered();
        requester = oov3_;
    }

    function requestId(bytes32 identifier, uint256 time, bytes memory ancillaryData) public pure returns (bytes32) {
        return keccak256(abi.encode(identifier, time, ancillaryData));
    }

    function requestPrice(bytes32 identifier, uint256 time, bytes memory ancillaryData) external {
        // OOv3 is the only caller that matters; others only create unanswerable noise, so they are ignored.
        if (msg.sender != requester) return;
        bytes32 id = requestId(identifier, time, ancillaryData);
        Request storage r = requests[id];
        if (r.requested) return;
        (r.requested, r.identifier, r.time, r.ancillaryData) = (true, identifier, time, ancillaryData);
        emit PriceRequested(id, identifier, time, ancillaryData);
    }

    /// @notice Team answer: 1e18 = assertion true; anything else = false. One answer per request.
    function pushPriceByRequestId(bytes32 id, int256 price) external onlyOwner {
        Request storage r = requests[id];
        if (!r.requested) revert NotRequested();
        if (r.answered) revert AlreadyAnswered();
        (r.answered, r.price) = (true, price);
        emit PricePushed(id, price);
    }

    function hasPrice(bytes32 identifier, uint256 time, bytes memory ancillaryData) external view returns (bool) {
        return requests[requestId(identifier, time, ancillaryData)].answered;
    }

    function getPrice(bytes32 identifier, uint256 time, bytes memory ancillaryData) external view returns (int256) {
        Request storage r = requests[requestId(identifier, time, ancillaryData)];
        if (!r.answered) revert NoPrice();
        return r.price;
    }
}
