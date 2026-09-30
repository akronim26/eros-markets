// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;
import {
    AccountingTestBase,
    AccountingHarness,
    MockRiskDecision,
    P
} from "../../risk/A/AccountingTestBase.sol";
import {StdInvariant} from "forge-std/StdInvariant.sol";
import {Test} from "forge-std/Test.sol";
import {RiskStorage} from "../../../src/risk/RiskStorage.sol";
import {MockUSDC} from "../../mocks/A/MockUSDC.sol";
import {CollateralVault} from "../../../src/vaults/CollateralVault.sol";
import {IntegratedVectors as V} from "./IntegratedVectors.sol";

contract AccountingHandler is Test {
    AccountingHarness immutable h;
    address immutable alice;
    address immutable bob;

    constructor(AccountingHarness h_, address a, address b) {
        h = h_;
        alice = a;
        bob = b;
    }

    function paired(uint32 size, uint16 tick, bool reverse) external {
        uint64 lots = uint64(uint256(size) % 1000 + 1);
        tick = uint16(uint256(tick) % 999 + 1);
        h.trade(reverse ? bob : alice, reverse ? alice : bob, lots, tick, 3, 7);
    }

    function sync(uint8 seconds_, bool which) external {
        (,, uint64 end,,,,) = h.epoch();
        uint256 t = block.timestamp + uint256(seconds_) % 20;
        if (t >= end) return;
        vm.warp(t);
        h.sync(which ? alice : bob);
    }

    function allocation(uint24 quantity, bool which, bool release_) external {
        address owner = which ? alice : bob;
        uint256 atoms = uint256(quantity) % 10000 + 1;
        CollateralVault vault = h.collateralVault();
        if (release_) {
            vm.prank(owner);
            h.release(atoms);
        } else {
            MockUSDC token = MockUSDC(address(vault.token()));
            token.mint(owner, atoms);
            vm.startPrank(owner);
            token.approve(address(vault), atoms);
            vault.deposit(atoms);
            vault.allocate(address(h), atoms, false);
            vm.stopPrank();
        }
    }

    function liquidation(uint16 quantity) external {
        int128 a = h.account(alice).value.lots;
        int128 b = h.account(bob).value.lots;
        if (a <= 0 || b >= 0) return;
        uint64 lots = uint64(uint256(quantity) % 1000 + 1);
        if (lots > uint128(a)) lots = uint64(uint128(a));
        if (lots > uint128(-b)) lots = uint64(uint128(-b));
        h.liquidationPair(bob, alice, lots, 600, address(0xBEEF));
    }

    function rollover(bool negative) external {
        (,, uint64 end,,,,) = h.epoch();
        vm.warp(end);
        h.beginRoll();
        h.rollPage(32);
        h.finishRoll(negative ? int256(-1e12) : int256(1e12), P.Tariff(1e14, 1e14, 1e18));
    }
}

contract AccountingInvariantsTest is AccountingTestBase {
    function setUp() public override {
        super.setUp();
        _trade();
        _roll(1e12, P.Tariff(1e14, 1e14, 1e18));
        AccountingHandler handler = new AccountingHandler(h, alice, bob);
        targetContract(address(handler));
    }

    function afterInvariant() public {
        h.freeze(uint64(block.timestamp));
        h.finalPrice(5e17, bytes32(uint256(1)));
        h.snapshotPage(32);
        h.scanPayout(32);
        h.allocatePayout(32);
        h.prepareReserve(32);
        if (h.claimableAtoms(alice) > 0) h.claimTrader(alice);
        if (h.claimableAtoms(bob) > 0) h.claimTrader(bob);
        assertEq(vault.marketAtoms(address(h)) * 1e18, h.allocationQ());
        assertGe(token.balanceOf(address(vault)), vault.recognizedAtoms());
    }

    function invariantConservationCoverageAndCustody() public view {
        _assertLedger();
    }
}

contract IndependentAccountingTraceTest is AccountingTestBase {
    function testIndependentIntegratedTrace() public {
        int256[9][] memory rows = V.trace();
        for (uint256 i; i < rows.length; i++) {
            int256[9] memory r = rows[i];
            bool buyA = r[0] == 1;
            h.trade(
                buyA ? alice : bob,
                buyA ? bob : alice,
                uint64(uint256(r[1])),
                uint16(uint256(r[2])),
                uint256(r[3]),
                uint256(r[4])
            );
            RiskStorage.Account memory a = h.account(alice);
            RiskStorage.Account memory b = h.account(bob);
            assertEq(a.value.cashQ, r[5]);
            assertEq(b.value.cashQ, r[6]);
            assertEq(a.value.lots, r[7]);
            assertEq(b.value.lots, r[8]);
            _assertLedger();
        }
    }
}
