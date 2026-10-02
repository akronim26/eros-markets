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
    function onCashClaim(address owner, uint256 atoms) external;
}

/// @notice Custody in six-decimal atoms, isolated allocations by registered engine, and global
///         per-beneficiary fee escrows in Q (A-I01). Custody identity, in Q:
///         recognizedAtoms * Q = sum(freeAtoms) * Q + sum(marketAtoms * Q - marketDebitQ)
///                                + totalFeeEscrowQ + sum(claimAtoms) * Q.
contract CollateralVault {
    ICollateralToken public immutable token;
    address public immutable governor;
    mapping(address => bool) public engines;
    mapping(address => uint256) public freeAtoms;
    mapping(address => uint256) public marketAtoms;
    mapping(address => mapping(address => uint256)) public claimAtoms;
    uint256 public recognizedAtoms;
    /// @notice Fractional Q below `marketAtoms * Q` already reclassified out of a market (< 1 atom).
    mapping(address => uint256) public marketDebitQ;
    /// @notice Global fee escrow per beneficiary, across markets, in Q.
    mapping(address => uint256) public feeEscrowQ;
    /// @notice Per-engine keeper fee Q reclassified but not yet assigned to an individual keeper;
    ///         the engine's `keeperQ` ledger says who owns it.
    mapping(address => uint256) public keeperPoolQ;
    /// @notice Sum of every `feeEscrowQ` and `keeperPoolQ`.
    uint256 public totalFeeEscrowQ;
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
    event FeesReclassified(
        address indexed engine, address indexed beneficiary, uint256 protocolQ, uint256 keeperQ
    );
    event KeeperFeeAssigned(address indexed engine, address indexed keeper, uint256 amountQ);
    event FeesPaid(address indexed owner, uint256 atoms);

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
        _takeMarketAtoms(msg.sender, atoms);
        freeAtoms[owner] += atoms;
        emit Released(msg.sender, owner, atoms);
    }

    function escrow(address owner, uint256 atoms) external onlyEngine lock {
        if (owner == address(0)) revert BadUnits();
        _takeMarketAtoms(msg.sender, atoms);
        claimAtoms[msg.sender][owner] += atoms;
        emit Escrowed(msg.sender, owner, atoms);
    }

    /// @notice Anyone may deliver, but the recipient is always the entitlement owner.
    function claim(address engine, address owner) external lock returns (uint256 atoms) {
        if (!engines[engine] || !IAllocationReceiver(engine).claimsEnabled()) revert Unauthorized();
        atoms = claimAtoms[engine][owner];
        if (atoms == 0) revert BadUnits();
        claimAtoms[engine][owner] = 0;
        recognizedAtoms -= atoms;
        IAllocationReceiver(engine).onCashClaim(owner, atoms);
        _send(owner, atoms);
        emit Paid(engine, owner, atoms);
    }

    /// @notice A-I01: move exact protocol and keeper fee Q out of the calling engine's market
    ///         allocation into vault fee escrows. Internal bookkeeping only; no token moves.
    function reclassifyFees(address protocolBeneficiary, uint256 protocolQ, uint256 keeperQ)
        external
        onlyEngine
        lock
    {
        if (protocolBeneficiary == address(0)) revert BadUnits();
        uint256 debit = marketDebitQ[msg.sender] + protocolQ + keeperQ;
        marketAtoms[msg.sender] -= debit / 1e18;
        marketDebitQ[msg.sender] = debit % 1e18;
        _checkMarket(msg.sender);
        feeEscrowQ[protocolBeneficiary] += protocolQ;
        keeperPoolQ[msg.sender] += keeperQ;
        totalFeeEscrowQ += protocolQ + keeperQ;
        emit FeesReclassified(msg.sender, protocolBeneficiary, protocolQ, keeperQ);
    }

    /// @notice Move a keeper's exact Q from the calling engine's keeper pool to the keeper's global
    ///         escrow, then pay the keeper's whole atoms to their free balance.
    function assignKeeperFee(address keeper, uint256 amountQ)
        external
        onlyEngine
        lock
        returns (uint256 atoms)
    {
        if (keeper == address(0)) revert BadUnits();
        keeperPoolQ[msg.sender] -= amountQ;
        feeEscrowQ[keeper] += amountQ;
        emit KeeperFeeAssigned(msg.sender, keeper, amountQ);
        atoms = _payFees(keeper);
    }

    /// @notice Pay floor(feeEscrowQ / Q) atoms to the caller's free balance; the fraction stays owed.
    function withdrawFees() external lock returns (uint256 atoms) {
        atoms = _payFees(msg.sender);
    }

    function _payFees(address owner) private returns (uint256 atoms) {
        atoms = feeEscrowQ[owner] / 1e18;
        if (atoms == 0) return 0;
        feeEscrowQ[owner] -= atoms * 1e18;
        totalFeeEscrowQ -= atoms * 1e18;
        freeAtoms[owner] += atoms;
        emit FeesPaid(owner, atoms);
    }

    function _takeMarketAtoms(address engine, uint256 atoms) private {
        marketAtoms[engine] -= atoms;
        _checkMarket(engine);
    }

    /// @dev A market can never pay out Q that was reclassified to a fee escrow.
    function _checkMarket(address engine) private view {
        if (marketAtoms[engine] * 1e18 < marketDebitQ[engine]) revert BadUnits();
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
