// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {ERC20} from "solady/tokens/ERC20.sol";
import {IMarketConfig} from "../../src/interfaces/IMarketConfig.sol";
import {HaltView, SettlementView} from "../../src/interfaces/IResolutionIngress.sol";
import {MathTypes} from "../../src/math/MathTypes.sol";
import {RegistryMarketCore} from "../../src/native/INativeMarketReads.sol";

/// @notice Plain six-decimal collateral with an open mint (test fixture, like testnet TestUSDC).
contract MockCollateral is ERC20 {
    uint8 internal immutable _dec;

    constructor(uint8 dec_) {
        _dec = dec_;
    }

    function name() public pure override returns (string memory) {
        return "Mock USDC";
    }

    function symbol() public pure override returns (string memory) {
        return "mUSDC";
    }

    function decimals() public view override returns (uint8) {
        return _dec;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/// @notice Collateral that delivers 1% less than requested on transferFrom (short transfer).
contract ShortCollateral is MockCollateral(6) {
    function transferFrom(address from, address to, uint256 amount) public override returns (bool) {
        uint256 fee = amount / 100;
        _burn(from, fee);
        return super.transferFrom(from, to, amount - fee);
    }
}

/// @notice Collateral that re-enters a target during transfers (reentrancy probe).
contract ReentrantCollateral is MockCollateral(6) {
    address public target;
    bytes public payload;
    bool public reentered;
    bytes public reentryError;

    function arm(address target_, bytes calldata payload_) external {
        target = target_;
        payload = payload_;
    }

    function _afterTokenTransfer(address, address, uint256) internal override {
        if (target == address(0) || reentered) return;
        reentered = true;
        (bool ok, bytes memory err) = target.call(payload);
        if (ok) revert("reentry succeeded");
        reentryError = err;
    }
}

/// @notice Scripted registry double: returns whatever core the test sets (agreed `getMarketCore` ABI).
contract MockRegistry {
    mapping(bytes32 => RegistryMarketCore) internal _cores;

    function setCore(bytes32 id, RegistryMarketCore memory c) external {
        _cores[id] = c;
    }

    function getMarketCore(bytes32 id) external view returns (RegistryMarketCore memory) {
        return _cores[id];
    }
}

/// @notice Scripted engine double for the vault's read boundary: listing, halt flag and the
///         settlement status. It implements no settlement economics; tests set its outputs.
contract MockEngine {
    IMarketConfig.Listing internal _l;
    bool public halted;
    MathTypes.FinalOutcome public outcome;
    bool public invalidReady;
    uint256 public invalidPrice;

    function setListing(bytes32 marketId, address token, address registry, uint64 t, bytes32 rules, address oracle)
        external
    {
        _l.marketId = marketId;
        _l.token = token;
        _l.registry = registry;
        _l.scheduledT = t;
        _l.rulesHash = rules;
        _l.resolutionAuthority = oracle;
    }

    function setHalted(bool h) external {
        halted = h;
    }

    function setOutcome(MathTypes.FinalOutcome o, bool ready, uint256 price) external {
        outcome = o;
        invalidReady = ready;
        invalidPrice = price;
    }

    function listing() external view returns (IMarketConfig.Listing memory) {
        return _l;
    }

    function listingHash() external view returns (bytes32) {
        return keccak256(abi.encode(_l));
    }

    function getHaltSnapshot() external view returns (HaltView memory h) {
        h.halted = halted;
    }

    /// @dev Mirrors the engine's reporting shape (SettlementController.getSettlementStatus):
    ///      price is reported only when ready, and 0 otherwise.
    function getSettlementStatus() external view returns (SettlementView memory v) {
        v.halted = halted;
        v.finalOutcome = outcome;
        v.oracleFinalityAccepted = outcome != MathTypes.FinalOutcome.UNSET;
        v.invalidPriceReady = invalidReady;
        if (outcome == MathTypes.FinalOutcome.YES) v.settlementPriceE18 = 1e18;
        else if (outcome == MathTypes.FinalOutcome.INVALID && invalidReady) v.settlementPriceE18 = invalidPrice;
        v.snapshotId = keccak256("snap");
    }
}
