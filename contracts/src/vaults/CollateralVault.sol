// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

interface ICollateralToken {
    function decimals() external view returns (uint8);
    function balanceOf(address) external view returns (uint256);
    function transfer(address, uint256) external returns (bool);
    function transferFrom(address, address, uint256) external returns (bool);
    function approve(address, uint256) external returns (bool);
}

interface IAllocationReceiver {
    function onAllocate(address owner, uint256 atoms) external;
    function onReserveAllocate(address owner, uint256 atoms) external;
    function claimsEnabled() external view returns (bool);
}

/// @notice Custody in six-decimal atoms, isolated allocations by registered engine.
contract CollateralVault {
    ICollateralToken public immutable token;
    address public immutable governor;
    mapping(address => bool) public engines;
    mapping(address => uint256) public freeAtoms;
    mapping(address => uint256) public marketAtoms;
    mapping(address => mapping(address => uint256)) public claimAtoms;
    uint256 public recognizedAtoms;
    uint256 private entered;
    error Unauthorized();
    error TransferFailed();
    error Reentrant();
    error BadUnits();
    event Deposit(address indexed owner, uint256 atoms);
    event Allocation(address indexed engine, address indexed owner, uint256 atoms, bool reserve);
    event Released(address indexed engine, address indexed owner, uint256 atoms);
    event Escrowed(address indexed engine, address indexed owner, uint256 atoms);
    event Paid(address indexed engine, address indexed owner, uint256 atoms);

    constructor(address token_, address governor_) {
        token = ICollateralToken(token_);
        governor = governor_;
        if (token.decimals() != 6 || governor_ == address(0)) revert BadUnits();
    }
    modifier lock() {
        if (entered != 0) revert Reentrant();
        entered = 1;
        _;
        entered = 0;
    }
    modifier onlyEngine() {
        if (!engines[msg.sender]) revert Unauthorized();
        _;
    }

    function registerEngine(address engine) external {
        if (msg.sender != governor || engine.code.length == 0 || engines[engine]) revert Unauthorized();
        engines[engine] = true;
    }

    function deposit(uint256 atoms) external lock {
        uint256 beforeBalance = token.balanceOf(address(this));
        if (
            atoms == 0 || !token.transferFrom(msg.sender, address(this), atoms)
                || token.balanceOf(address(this)) - beforeBalance != atoms
        ) revert TransferFailed();
        freeAtoms[msg.sender] += atoms;
        recognizedAtoms += atoms;
        emit Deposit(msg.sender, atoms);
    }

    function withdraw(uint256 atoms) external lock {
        freeAtoms[msg.sender] -= atoms;
        recognizedAtoms -= atoms;
        _send(msg.sender, atoms);
    }

    function allocate(address engine, uint256 atoms, bool reserve) external lock {
        if (!engines[engine] || atoms == 0) revert Unauthorized();
        freeAtoms[msg.sender] -= atoms;
        marketAtoms[engine] += atoms;
        if (reserve) IAllocationReceiver(engine).onReserveAllocate(msg.sender, atoms);
        else IAllocationReceiver(engine).onAllocate(msg.sender, atoms);
        emit Allocation(engine, msg.sender, atoms, reserve);
    }

    function release(address owner, uint256 atoms) external onlyEngine lock {
        marketAtoms[msg.sender] -= atoms;
        freeAtoms[owner] += atoms;
        emit Released(msg.sender, owner, atoms);
    }

    function escrow(address owner, uint256 atoms) external onlyEngine lock {
        if (owner == address(0)) revert BadUnits();
        marketAtoms[msg.sender] -= atoms;
        claimAtoms[msg.sender][owner] += atoms;
        emit Escrowed(msg.sender, owner, atoms);
    }

    /// @notice Anyone may deliver, but the recipient is always the entitlement owner.
    function claim(address engine, address owner) external lock returns (uint256 atoms) {
        if (!IAllocationReceiver(engine).claimsEnabled()) revert Unauthorized();
        atoms = claimAtoms[engine][owner];
        if (atoms == 0) revert BadUnits();
        claimAtoms[engine][owner] = 0;
        recognizedAtoms -= atoms;
        _send(owner, atoms);
        emit Paid(engine, owner, atoms);
    }

    function addBackingFromEngine(uint256 atoms) external onlyEngine lock {
        uint256 beforeBalance = token.balanceOf(address(this));
        if (
            !token.transferFrom(msg.sender, address(this), atoms)
                || token.balanceOf(address(this)) - beforeBalance != atoms
        ) revert TransferFailed();
        recognizedAtoms += atoms;
        marketAtoms[msg.sender] += atoms;
    }

    function _send(address owner, uint256 atoms) private {
        uint256 beforeVault = token.balanceOf(address(this));
        uint256 beforeOwner = token.balanceOf(owner);
        if (
            !token.transfer(owner, atoms) || beforeVault - token.balanceOf(address(this)) != atoms
                || token.balanceOf(owner) - beforeOwner != atoms
        ) revert TransferFailed();
        if (token.balanceOf(address(this)) < recognizedAtoms) revert TransferFailed();
    }
}
