// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;
import {AccountingTestBase, P} from "../../risk/A/AccountingTestBase.sol";
import {LedgerMath as L} from "../../../src/math/LedgerMath.sol";

contract AccountingGasTest is AccountingTestBase {
    function setUp() public override {
        super.setUp();
        for (uint256 i = 2; i < 1024; i++) {
            address owner = address(uint160(100000 + i));
            _fund(owner, 1e6, false);
            decision.set(owner, true);
            if (i % 2 == 1) h.trade(address(uint160(100000 + i - 1)), owner, 10000, 600, 3, 7);
        }
    }

    function measuredPremium(P.Segment memory s, P.Tariff memory t, uint64 until)
        external
        pure
        returns (uint256)
    {
        return P.cumulative(s, t, until);
    }

    function testGasMathAndActivePremiumTouch() public {
        P.Segment memory s = P.Segment(-480e24, 1000000, 1e12, 1, 1800, 900);
        P.Tariff memory t = P.Tariff(1e14, 1e14, 1e18);
        uint256 g = gasleft();
        uint256 premium = this.measuredPremium(s, t, 3601);
        emit log_named_uint("premium_math_gas", g - gasleft());
        assertGt(premium, 0);
        _trade();
        _roll(1e12, t);
        vm.warp(block.timestamp + 100);
        g = gasleft();
        h.sync(alice);
        emit log_named_uint("funding_premium_touch_gas", g - gasleft());
        assertGt(h.account(alice).premiumPaid, 0);
    }

    function testGasBounded1024AccountJobs() public {
        _trade();
        _roll(1e12, P.Tariff(1e14, 1e14, 1e18));
        vm.warp(_epochEnd());
        uint256 g = gasleft();
        h.beginRoll();
        emit log_named_uint("roll_begin_gas", g - gasleft());
        uint256 maxPage;
        for (uint256 i; i < 32; i++) {
            g = gasleft();
            h.rollPage(32);
            uint256 used = g - gasleft();
            if (used > maxPage) maxPage = used;
        }
        emit log_named_uint("roll_32_account_max_gas", maxPage);
        assertEq(h.cursor(), 1024);
        h.finishRoll(0, P.Tariff(0, 0, 0));
        g = gasleft();
        h.freeze(uint64(block.timestamp));
        emit log_named_uint("halt_1024_gas", g - gasleft());
        maxPage = 0;
        for (uint256 i; i < 32; i++) {
            g = gasleft();
            h.snapshotPage(32);
            uint256 used = g - gasleft();
            if (used > maxPage) maxPage = used;
        }
        emit log_named_uint("snapshot_32_account_max_gas", maxPage);
        h.finalPrice(5e17, bytes32(uint256(1)));
        for (uint256 i; i < 32; i++) {
            h.scanPayout(32);
        }
        for (uint256 i; i < 32; i++) {
            h.allocatePayout(32);
        }
        h.prepareReserve(32);
        g = gasleft();
        h.claimTrader(alice);
        emit log_named_uint("trader_claim_gas", g - gasleft());
        emit log_named_uint("participant_count", h.participantCount());
        assertTrue(h.claimsEnabled());
    }
}
