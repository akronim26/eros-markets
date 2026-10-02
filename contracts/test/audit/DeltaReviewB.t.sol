// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {CombinedBase} from "../integration/CombinedBase.sol";
import {IBookRiskHooks} from "../../src/interfaces/IBookRiskHooks.sol";
import {SettlementView} from "../../src/interfaces/IResolutionIngress.sol";
import {MathTypes} from "../../src/math/MathTypes.sol";
import {ClearingPhase} from "../../src/math/RiskTypes.sol";
import {MarginMath} from "../../src/math/MarginMath.sol";

/// @notice Person B's independent checks of Person A's 2026-10-02 delta (71576ed..3b11044),
///         written separately from A's regressions. Real A+B; book, price feed, oracle mocked.
contract DeltaReviewBTest is CombinedBase {
    MathTypes.Side constant BUY = MathTypes.Side.BUY;
    MathTypes.Side constant SELL = MathTypes.Side.SELL;
    uint64 lastFeed;

    function _feed(uint64 to, uint256 idx) internal {
        uint64 from = to - 990 > lastFeed + 10 ? to - 990 : lastFeed + 10;
        vm.warp(to);
        e.feed(from, to, idx, idx - 1e16, idx + 1e16);
        lastFeed = to - ((to - from) % 10);
        if (block.timestamp >= _epochEnd()) _roll(32);
    }

    function _reduceOnlySell(uint32 id, uint16 limit, uint64 lots)
        internal
        pure
        returns (IBookRiskHooks.OrderRequest memory)
    {
        return IBookRiskHooks.OrderRequest(id, SELL, IBookRiskHooks.OrderKind.IOC, limit, lots, 0, true, 8);
    }

    /// A-B03: a voluntary reduce-only fill that shrinks both endpoint deficits but leaves negative
    /// mark equity must not execute; a fill at a fair price still reduces.
    function test_AB03_underwaterVoluntaryReductionRejected() public {
        _deploy(5, 100_000);
        uint256[] memory u = new uint256[](4);
        (u[0], u[1], u[2], u[3]) = (120, 400, 400, 1000);
        _traders(u);
        _activate();
        lastFeed = L0 - 1000;
        _feed(L0 + 12 hours, 6e17);
        e.rest(2, SELL, 600, 1_000_000);
        assertEq(e.place(_ioc(1, BUY, 600, 1_000_000)).filledLots, 1_000_000); // Alice 5x long
        uint256 p = 6e17;
        while (p > 52e16) {
            p -= 4e16;
            _feed(uint64(block.timestamp) + 20 minutes, p);
        }
        _feed(uint64(block.timestamp) + 20 minutes, p);
        assertGt(e.previewAccount(1).markEquityQ, 0, "positive equity before");
        // Selling 500 claims at 0.400 when the mark is 0.520: NO deficit 480 -> 280, YES deficit
        // stays 0 (E1 = 220), but mark equity becomes about -20 USDC.
        e.rest(3, BUY, 400, 500_000);
        assertEq(e.place(_reduceOnlySell(1, 400, 500_000)).filledLots, 0, "underwater reduction refused");
        assertEq(_lots(1), 1_000_000);
        // The same reduction at a fair bid executes.
        e.rest(4, BUY, 515, 500_000);
        assertEq(e.place(_reduceOnlySell(1, 515, 500_000)).filledLots, 500_000, "fair reduction executes");
        assertEq(_lots(1), 500_000);
        _assertInvariants();
    }

    /// Claims port: COMPLETE only after every nonzero trader entitlement is paid, including a
    /// claim delivered directly through the vault rather than the engine wrapper.
    function test_claimsCompleteCountsDirectVaultClaims() public {
        _deploy(5, 100_000);
        uint256[] memory u = new uint256[](3);
        (u[0], u[1], u[2]) = (120, 100, 50);
        _traders(u);
        _activate();
        lastFeed = L0 - 1000;
        _feed(L0 + 12 hours, 6e17);
        e.rest(2, SELL, 600, 1_000_000);
        assertEq(e.place(_ioc(1, BUY, 600, 1_000_000)).filledLots, 1_000_000);
        vm.warp(block.timestamp + 60);
        oracle.haltEarly();
        oracle.finalize(2); // NO: Alice 0, Bob ~700, Zed (trader 3) 50
        while (!e.prepareSnapshotChunk(32).done) {}
        while (!e.preparePayoutChunk(32).done) {}
        assertTrue(e.finishPreparation());
        assertEq(e.unpaidTraderClaims(), 2, "Bob and the inactive cash holder");
        assertEq(uint8(e.getSettlementStatus().phase), uint8(ClearingPhase.READY));
        e.claimTrader(_who(2));
        assertFalse(e.allTraderClaimsPaid());
        vault.claim(address(e), _who(3)); // direct vault delivery, not the engine wrapper
        assertTrue(e.allTraderClaimsPaid());
        assertTrue(e.anyCashClaim());
        assertEq(uint8(e.getSettlementStatus().phase), uint8(ClearingPhase.COMPLETE));
    }
}
