// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;
import {QMath as Q} from "./QMath.sol";

library FeeMath {
    error Domain();

    function commitment(uint256 valueQ, uint256 feeWad) internal pure returns (uint256) {
        if (feeWad > 1e18) revert Domain();
        return Q.mulDivUp(valueQ, feeWad, 1e18);
    }

    /// @notice Attribution of a precommitted cap, not independent per-fill atom ceilings.
    function fragment(uint256 capQ, uint64 original, uint64 beforeLots, uint64 afterLots)
        internal
        pure
        returns (uint256)
    {
        if (original == 0 || afterLots > original || beforeLots > afterLots) revert Domain();
        return Q.mulDiv(capQ, afterLots, original) - Q.mulDiv(capQ, beforeLots, original);
    }

    function liquidation(uint64 lots) internal pure returns (uint256 reserveQ, uint256 keeperQ) {
        uint256 fee = uint256(lots) * 1e18;
        keeperQ = fee / 2;
        reserveQ = fee - keeperQ;
    }
}
