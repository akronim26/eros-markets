// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {OrderRisk} from "../../../src/risk/OrderRisk.sol";
import {OrderAdmissionMath as OA} from "../../../src/math/OrderAdmissionMath.sol";
import {MockAccountingPort} from "../../mocks/B/MockAccountingPort.sol";
import {MathTypes} from "../../../src/math/MathTypes.sol";

contract ResHarness is OrderRisk, MockAccountingPort {
    function act(uint32 t) public {
        _acctBeginAction();
        _acctTouch(t);
    }

    function add(uint32 t, bool isBid, uint16 tick, uint64 lots, uint256 fee)
        external
        returns (uint64, uint64)
    {
        act(t);
        return _resAdd(t, isBid, tick, lots, fee);
    }

    function remove(uint32 t, uint64 m, uint64 a, bool isBid, uint16 tick, uint64 lots, uint256 fee)
        external
        returns (bool)
    {
        act(t);
        return _resRemove(t, m, a, isBid, tick, lots, fee);
    }

    function cancelAll(uint32 t) external returns (uint64, uint64) {
        act(t);
        return _resCancelAll(t);
    }

    function bumpMarket() external {
        _acctBumpMarketOrderEpoch();
    }

    function sums(uint32 t) external view returns (OA.OrderSums memory) {
        return _resSums(t);
    }

    function sync(uint32 t) external returns (bool) {
        act(t);
        return _resSyncEpoch(t);
    }

    function writeSidecar(uint32 slot, uint24 gen, uint64 a) external {
        _sidecarWrite(slot, Sidecar(gen, 1, MathTypes.Side.BUY, 500, 1, a, 0, 0, false));
    }

    function readSidecar(uint32 slot, uint24 gen) external view returns (Sidecar memory) {
        return _sidecarRead(slot, gen);
    }
}

/// B022: generation-scoped reservations.
contract B022Test is Test {
    uint256 constant Q = 1e18;
    ResHarness h;

    function setUp() public {
        h = new ResHarness();
        h.mockSetAccount(1, 0, 0);
    }

    function test_cancelUsesExactTick() public {
        (uint64 m, uint64 a) = h.add(1, true, 400, 7, 0);
        h.add(1, true, 600, 11, 0);
        assertTrue(h.remove(1, m, a, true, 400, 7, 0));
        OA.OrderSums memory s = h.sums(1);
        assertEq(s.bidLots, 11);
        assertEq(s.bidValueQ, 6600 * Q, "6,600 atoms, not an average price");
        assertEq(s.maxBidTick, 600);
        (OA.OrderSums memory contrib) = _contribution(1);
        assertEq(contrib.bidValueQ, 6600 * Q, "A contribution replaced with the exact sums");
    }

    function _contribution(uint32 t) internal view returns (OA.OrderSums memory s) {
        (s.bidLots, s.bidValueQ, s.askLots, s.askValueQ, s.feeCapQ, s.maxBidTick, s.minAskTick) =
            h.mockContribution(t);
    }

    function test_oldEpochPruneCannotSubtractNew() public {
        (uint64 m1, uint64 a1) = h.add(1, true, 400, 7, 0);
        h.add(1, false, 700, 5, 0);
        (uint64 m2, uint64 a2) = h.cancelAll(1);
        assertEq(a2, a1 + 1);
        assertEq(m2, m1);
        h.add(1, true, 450, 3, 0);
        // lazy physical pruning of the two old nodes
        assertFalse(h.remove(1, m1, a1, true, 400, 7, 0));
        assertFalse(h.remove(1, m1, a1, false, 700, 5, 0));
        OA.OrderSums memory s = h.sums(1);
        assertEq(s.bidLots, 3);
        assertEq(s.bidValueQ, 1350 * Q);
        assertEq(s.askLots, 0);
    }

    function test_marketEpochInvalidatesWithoutVisiting() public {
        (uint64 m1, uint64 a1) = h.add(1, true, 400, 7, 0);
        h.bumpMarket(); // stage/rollover invalidation: no account is visited
        assertEq(h.sums(1).bidLots, 0, "stale epoch reads as empty");
        assertTrue(h.sync(1), "cleared once on the next touch");
        assertFalse(h.sync(1), "second touch does nothing");
        assertFalse(h.remove(1, m1, a1, true, 400, 7, 0), "old order is a no-op");
    }

    function test_underflowAndWrongTickRevert() public {
        (uint64 m, uint64 a) = h.add(1, true, 400, 7, 0);
        vm.expectRevert(OA.ReservationUnderflow.selector);
        h.remove(1, m, a, true, 400, 8, 0);
        vm.expectRevert(OA.ReservationUnderflow.selector);
        h.remove(1, m, a, true, 500, 7, 0);
        vm.expectRevert(OA.ReservationUnderflow.selector);
        h.remove(1, m, a, true, 400, 7, 1);
    }

    function test_feeCommitmentExact() public {
        (uint64 m, uint64 a) = h.add(1, false, 550, 10, 30 * Q);
        h.add(1, false, 560, 5, 7 * Q);
        assertEq(h.sums(1).feeCapQ, 37 * Q);
        h.remove(1, m, a, false, 550, 10, 30 * Q);
        assertEq(h.sums(1).feeCapQ, 7 * Q);
        assertEq(h.sums(1).minAskTick, 550, "extremum stays pessimistic until the epoch clears");
    }

    function test_sidecarGenerationGuard() public {
        h.writeSidecar(9, 3, 42);
        assertEq(h.readSidecar(9, 3).accountEpoch, 42);
        vm.expectRevert(OrderRisk.SidecarGenerationMismatch.selector);
        h.readSidecar(9, 2);
        h.writeSidecar(9, 4, 43); // slot reuse overwrites
        vm.expectRevert(OrderRisk.SidecarGenerationMismatch.selector);
        h.readSidecar(9, 3);
    }

    function test_fullUint64Epochs() public {
        // account epoch beyond uint32 is compared in full width
        h.mockSetAccount(2, 0, 0);
        for (uint256 i; i < 3; ++i) {
            h.cancelAll(2);
        }
        (uint64 m, uint64 a) = h.add(2, true, 500, 1, 0);
        assertEq(a, 4);
        assertFalse(h.remove(2, m, a - 1, true, 500, 1, 0));
        assertFalse(h.remove(2, m, a + (uint64(1) << 32), true, 500, 1, 0), "low 32 bits alone never match");
        assertTrue(h.remove(2, m, a, true, 500, 1, 0));
    }
}
