// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {HaltView, FinalOutcome} from "@eros/interfaces/IResolutionIngress.sol";
import {ResolutionEngineStub} from "../../src/testnet/ResolutionEngineStub.sol";

/// @title MockResolutionEngine
/// @notice The testnet stub engine plus test knobs (plan §6.10, §11.1; task O11.1). Every knob is
///         open to any caller: this is a test double, never deployed.
contract MockResolutionEngine is ResolutionEngineStub {
    error MockSettleReverted();

    bool public revertOnSettle;
    bytes32 public listingHashOverride; // non-zero: reported instead of the real hash
    int64 public haltTimeSkew; // added to economicHaltAt at the halt (misbehaving engine)
    uint256 public settleCalls;

    function setRevertOnSettle(bool v) external {
        revertOnSettle = v;
    }

    function setOiLots(uint256 lots) external {
        _oiLots = lots;
    }

    function setListingHashOverride(bytes32 h) external {
        listingHashOverride = h;
    }

    function setHaltTimeSkew(int64 skew) external {
        haltTimeSkew = skew;
    }

    /// @notice Makes the engine look halted before the oracle ever halts it.
    function forceHalted() external {
        _materialize(false);
    }

    function settle(uint8 Y) external override returns (bool) {
        if (revertOnSettle) revert MockSettleReverted();
        ++settleCalls;
        _onlyAuthority();
        if (Y > 1) revert BadOutcome();
        return _accept(Y == 1 ? FinalOutcome.YES : FinalOutcome.NO);
    }

    function settleInvalid() external override returns (bool) {
        if (revertOnSettle) revert MockSettleReverted();
        ++settleCalls;
        _onlyAuthority();
        return _accept(FinalOutcome.INVALID);
    }

    function listingHash() external view override returns (bytes32) {
        return listingHashOverride != bytes32(0) ? listingHashOverride : _listingHash;
    }

    function _materialize(bool byOracle) internal override {
        bool wasHalted = _halt.halted;
        super._materialize(byOracle);
        if (!wasHalted && haltTimeSkew != 0) {
            _halt.economicHaltAt = uint64(int64(_halt.economicHaltAt) + haltTimeSkew);
        }
    }

    function rawHalt() external view returns (HaltView memory) {
        return _halt;
    }
}
