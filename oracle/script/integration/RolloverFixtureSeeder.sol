// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

interface IFixtureToken {
    function mint(address owner, uint256 atoms) external;
    function approve(address spender, uint256 atoms) external returns (bool);
}

interface IFixtureVault {
    function token() external view returns (address);
    function engines(address engine) external view returns (bool);
    function deposit(uint256 atoms) external;
    function allocate(address engine, uint256 atoms, bool reserve) external;
}

interface IFixtureEngine {
    function collateralVault() external view returns (address);
    function participantCount() external view returns (uint256);
    function participantId(address owner) external view returns (uint256);
}

/// @dev Disposable local test owner. Its constructor performs actual owner-correct
/// mint/approve/deposit/allocate calls against the real local vault and engine.
contract RolloverFixtureOwner {
    constructor(IFixtureEngine engine, IFixtureVault vault) {
        require(block.chainid == 31337, "local fixture only");
        IFixtureToken token = IFixtureToken(vault.token());
        token.mint(address(this), 100e6);
        require(token.approve(address(vault), 100e6), "fixture approval");
        vault.deposit(100e6);
        vault.allocate(address(engine), 100e6, false);
        require(engine.participantId(address(this)) != 0, "fixture participant missing");
    }
}

/// @notice Local-only scaffolding for measured 1,024-owner RPC rollover campaigns.
/// @dev This is not a production deployment component. It requires a mintable
/// local mock token and never bypasses the vault/engine allocation checks.
contract RolloverFixtureSeeder {
    IFixtureEngine public immutable engine;
    IFixtureVault public immutable vault;
    address public immutable operator;

    event OwnersSeeded(uint256 beforeCount, uint256 afterCount);

    constructor(address engine_) {
        require(block.chainid == 31337, "local fixture only");
        engine = IFixtureEngine(engine_);
        vault = IFixtureVault(engine.collateralVault());
        require(vault.engines(engine_), "unbound engine");
        operator = msg.sender;
    }

    function seed(uint8 owners) external {
        require(block.chainid == 31337 && msg.sender == operator, "local operator only");
        require(owners > 0 && owners <= 16, "bounded fixture seed");
        uint256 beforeCount = engine.participantCount();
        require(beforeCount + owners <= 1024, "participant cap");
        for (uint256 index; index < owners; ++index) {
            new RolloverFixtureOwner(engine, vault);
        }
        uint256 afterCount = engine.participantCount();
        require(afterCount == beforeCount + owners, "fixture count mismatch");
        emit OwnersSeeded(beforeCount, afterCount);
    }
}
