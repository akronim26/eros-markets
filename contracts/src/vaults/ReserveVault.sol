// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

/// @notice Locked, nontransferable reserve shares; never a live ERC-4626 NAV.
contract ReserveVault {
    address public immutable engine;
    address[] public holders;
    mapping(address => uint256) public shares;
    mapping(address => uint256) public noticedShares;
    mapping(address => uint64) public noticeAt;
    mapping(address => uint256) public preparedAtoms;
    mapping(address => bool) public redeemed;
    uint256 public totalShares;
    bool public active;
    bool public prepared;
    error Unauthorized();
    error Locked();

    constructor(address engine_) {
        engine = engine_;
    }
    modifier onlyEngine() {
        if (msg.sender != engine) revert Unauthorized();
        _;
    }

    function mintSeed(address owner, uint256 atoms) external onlyEngine {
        if (active || atoms == 0 || owner == address(0)) revert Locked();
        if (shares[owner] == 0) {
            if (holders.length == 256) revert Locked();
            holders.push(owner);
        }
        shares[owner] += atoms;
        totalShares += atoms;
    }

    function activate() external onlyEngine {
        if (active) revert Locked();
        active = true;
    }

    function notice() external {
        if (shares[msg.sender] == 0 || noticedShares[msg.sender] == shares[msg.sender]) revert Locked();
        noticedShares[msg.sender] = shares[msg.sender];
        noticeAt[msg.sender] = uint64(block.timestamp);
    }

    function prepare(address owner, uint256 atoms) external onlyEngine {
        if (prepared) revert Locked();
        preparedAtoms[owner] = atoms;
    }

    function finish() external onlyEngine {
        if (prepared) revert Locked();
        prepared = true;
    }

    function consume(address owner) external onlyEngine returns (uint256 atoms) {
        if (
            !prepared || redeemed[owner] || noticedShares[owner] != shares[owner] || shares[owner] == 0
                || block.timestamp < uint256(noticeAt[owner]) + 7 days
        ) revert Locked();
        redeemed[owner] = true;
        atoms = preparedAtoms[owner];
    }

    function holderCount() external view returns (uint256) {
        return holders.length;
    }

    function maxRedeem(address owner) external view returns (uint256) {
        if (
            !prepared || redeemed[owner] || noticedShares[owner] != shares[owner] || noticeAt[owner] == 0
                || block.timestamp < uint256(noticeAt[owner]) + 7 days
        ) return 0;
        return shares[owner];
    }
}
