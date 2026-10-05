pragma solidity ^0.8.30;

import {ERC20} from "solady/tokens/ERC20.sol";
import {HaltView, IResolutionEngine} from "../../../src/interfaces/IResolutionIngress.sol";

abstract contract TestnetFixtureControl {
    address public immutable controller;

    error UnsupportedFixtureChain();
    error InvalidFixtureController();
    error FixtureUnauthorized();

    constructor(address controller_) {
        if (block.chainid != 10143 && block.chainid != 31337) revert UnsupportedFixtureChain();
        if (controller_ == address(0)) revert InvalidFixtureController();
        controller = controller_;
    }

    modifier onlyFixtureController() {
        if (msg.sender != controller) revert FixtureUnauthorized();
        _;
    }
}

contract TestnetRiskCollateral is ERC20, TestnetFixtureControl {
    error InvalidTestRecipient();

    constructor(address controller_) TestnetFixtureControl(controller_) {}

    function name() public pure override returns (string memory) {
        return "Risk Book Testnet Fixture Collateral";
    }

    function symbol() public pure override returns (string memory) {
        return "RISK-TEST";
    }

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address owner, uint256 atoms) external onlyFixtureController {
        if (owner == address(0)) revert InvalidTestRecipient();
        _mint(owner, atoms);
    }
}

contract TestnetResolutionAuthority is TestnetFixtureControl {
    IResolutionEngine public engine;

    error FixtureAlreadyBound();
    error FixtureNotBound();
    error InvalidFixtureEngine();
    error InvalidBinaryOutcome();

    event TestEngineBound(address indexed engine);

    constructor(address controller_) TestnetFixtureControl(controller_) {}

    function bind(IResolutionEngine engine_) external onlyFixtureController {
        if (address(engine) != address(0)) revert FixtureAlreadyBound();
        if (address(engine_).code.length == 0) revert InvalidFixtureEngine();
        engine = engine_;
        emit TestEngineBound(address(engine_));
    }

    function halt() external onlyFixtureController returns (HaltView memory) {
        return _boundEngine().halt();
    }

    function finalize(uint8 binaryOutcome) external onlyFixtureController returns (bool) {
        if (binaryOutcome > 1) revert InvalidBinaryOutcome();
        return _boundEngine().settle(binaryOutcome);
    }

    function finalizeInvalid() external onlyFixtureController returns (bool) {
        return _boundEngine().settleInvalid();
    }

    function _boundEngine() internal view returns (IResolutionEngine) {
        if (address(engine) == address(0)) revert FixtureNotBound();
        return engine;
    }
}
