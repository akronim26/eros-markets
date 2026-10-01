// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {CombinedBase} from "../integration/CombinedBase.sol";
import {RiskStorage} from "../../src/risk/RiskStorage.sol";
import {TradePreview} from "../../src/risk/TradePreview.sol";
import {RiskContext} from "../../src/pricing/RiskPricing.sol";
import {MarginMath} from "../../src/math/MarginMath.sol";
import {MathTypes} from "../../src/math/MathTypes.sol";
import {PricingMode} from "../../src/math/RiskTypes.sol";
import {RiskFixture} from "../math/B/B011.t.sol";

/// @notice G3 — storage and risk context joined. Real A custody/ledger/coverage and real B
///         context/margin/release decision in CombinedEngine (no A or B double). Book, price
///         source and oracle are mocks.
contract G3Test is CombinedBase {
    function setUp() public {
        _deploy(5, 100_000);
        uint256[] memory u = new uint256[](4);
        (u[0], u[1], u[2], u[3]) = (120, 400, 10, 400);
        _traders(u);
        _activate();
        _keep(L0 + 600, 6e17, false);
    }

    function test_allocationVisibleToBothLanes() public view {
        // Custody (A017) -> account cash (A018) -> B's account view and preview, same Q.
        assertEq(vault.marketAtoms(address(e)), (100_000 + 120 + 400 + 10 + 400) * 1e6);
        TradePreview.AccountPreview memory p = e.previewAccount(1);
        assertEq(p.cashQ, _cash(1));
        assertEq(p.cashQ, int256(120 * USDC));
        assertEq(p.positionLots, 0);
        _assertInvariants();
    }

    function test_contextCutoffsAndVersionsAgree() public view {
        RiskStorage.Context memory a = e.accountingContext();
        RiskContext memory b = e.riskContext();
        assertEq(a.at, uint64(block.timestamp));
        assertEq(a.at, b.economicTime);
        assertEq(a.version, b.riskVersion);
        assertEq(a.markAvailable, b.markOk);
        assertEq(uint8(b.pricingMode), uint8(PricingMode.BOOTSTRAP));
    }

    function test_bootstrapStartupPath() public {
        e.rest(2, MathTypes.Side.SELL, 600, 1000);
        assertEq(e.place(_ioc(3, MathTypes.Side.BUY, 600, 1000)).filledLots, 1000);
        assertEq(e.place(_ioc(1, MathTypes.Side.BUY, 600, 1_000_000)).filledLots, 0);
        assertEq(_lots(3), 1000);
        assertEq(_cash(3), int256(10 * USDC) - int256(600_000 * Q));
        _assertInvariants();
    }

    function test_guardedReleaseBootstrap() public {
        // Missing normal mark: only an exactly backed result may release.
        uint256 before = vault.freeAtoms(_who(3));
        vm.prank(_who(3));
        e.release(10e6);
        assertEq(vault.freeAtoms(_who(3)) - before, 10e6);
        _assertInvariants();
    }

    function test_guardedReleaseCannotBypassRiskDecision() public {
        _keep(L0 + 12 hours, 6e17, true);
        _roll(32);
        e.rest(4, MathTypes.Side.SELL, 600, 1_000_000);
        assertEq(e.place(_ioc(1, MathTypes.Side.BUY, 600, 1_000_000)).filledLots, 1_000_000);
        // Alice at exactly IM: B's decision rejects any release; A's release reverts.
        TradePreview.AccountPreview memory pa = e.previewAccount(1);
        assertEq(pa.usableReleaseAtoms, 0);
        vm.prank(_who(1));
        vm.expectRevert(RiskStorage.Rejected.selector);
        e.release(1);
        // Bob (short, fully backed at 1000 cash) may release down to his short IM.
        TradePreview.AccountPreview memory pb = e.previewAccount(4);
        uint256 usable = pb.usableReleaseAtoms;
        assertGt(usable, 0);
        vm.prank(_who(4));
        vm.expectRevert(RiskStorage.Rejected.selector);
        e.release(usable + 1);
        vm.prank(_who(4));
        e.release(usable);
        assertEq(_cash(4), int256(1000 * USDC) - int256(usable * Q));
        // Margin from the stored values matches B's kernel on the same account.
        MarginMath.Margin memory m =
            MarginMath.sideMargin(1_000_000, false, 6e17, T - uint64(block.timestamp), block.timestamp, RiskFixture.profile(5, true));
        TradePreview.AccountPreview memory after_ = e.previewAccount(4);
        assertEq(after_.imQ, m.imQ);
        assertGe(after_.markEquityQ, int256(m.imQ));
        _assertInvariants();
    }
}
