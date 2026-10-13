pragma solidity ^0.8.30;

import {Book} from "../../src/Book.sol";
import {IBookRiskHooks} from "../../src/interfaces/IBookRiskHooks.sol";
import {IPriceSource} from "../../src/interfaces/IPriceSource.sol";
import {BookRiskEngineFixture} from "./BookRiskEngine.t.sol";

/// @notice A long opened at 0.55 and closed at 0.60 after the signed index rises releases its
///         0.05/claim gain to the vault and out to the wallet, on the real engine, book and vault.
contract IndexRiseCloseProfitTest is BookRiskEngineFixture {
    address constant BIDDER = address(0x103);
    uint64 constant LOTS = 100_000; // 100 claims
    uint64 sequence;

    function _observe(uint256 priceWad, uint256 count) internal {
        for (uint256 i; i < count; ++i) {
            if (sequence != 0) vm.warp(block.timestamp + 10);
            IPriceSource.Observation memory observation = _observation(++sequence);
            observation.priceWad = priceWad;
            observation.impactBidWad = priceWad - 1e16;
            observation.impactAskWad = priceWad + 1e16;
            engine.submitObservation(observation, _signature(observation, SIGNER_KEY));
        }
    }

    function _trade(address owner, bool isBuy, bool reduceOnly, IBookRiskHooks.OrderKind kind, uint16 tick)
        internal
        returns (uint32)
    {
        vm.prank(owner);
        return engine.placeOrder(Book.Place(kind, isBuy, reduceOnly, tick, LOTS, 8, 0));
    }

    function _released(address owner) internal {
        int256 cashQ = engine.account(owner).value.cashQ;
        vm.prank(owner);
        engine.release(uint256(cashQ) / 1e18);
        uint256 atoms = vault.freeAtoms(owner);
        vm.prank(owner);
        vault.withdraw(atoms);
    }

    function testLongClosedAfterIndexRiseWithdrawsProfit() public {
        _fund(BIDDER);
        _observe(55e16, 31);
        assertTrue(engine.riskContext().indexOk);

        // Open: BUYER lifts SELLER's 0.55 ask.
        uint32 ask = _trade(SELLER, false, false, IBookRiskHooks.OrderKind.LIMIT, 550);
        assertGt(ask, 0);
        _trade(BUYER, true, false, IBookRiskHooks.OrderKind.IOC, 550);
        assertEq(engine.getOrder(ask).size, 0, "open filled");
        assertEq(engine.account(BUYER).value.lots, int256(uint256(LOTS)));
        assertEq(engine.account(BUYER).value.cashQ, int256(45e6) * 1e18, "100 - 55 USDC");

        // The index rises to 0.60.
        _observe(60e16, 31);
        assertTrue(engine.riskContext().indexOk);

        // Close: BUYER sells into BIDDER's 0.60 bid, reduce-only.
        uint32 bid = _trade(BIDDER, true, false, IBookRiskHooks.OrderKind.LIMIT, 600);
        assertGt(bid, 0);
        _trade(BUYER, false, true, IBookRiskHooks.OrderKind.IOC, 600);
        assertEq(engine.getOrder(bid).size, 0, "close filled");
        assertEq(engine.account(BUYER).value.lots, 0, "flat");
        assertEq(engine.account(BUYER).value.cashQ, int256(105e6) * 1e18, "45 + 60 USDC");

        // Extract: release from the engine, withdraw from the vault.
        _released(BUYER);
        assertEq(token.balanceOf(BUYER), 105e6, "deposit 100 + profit 5 USDC");
        assertEq(engine.account(BUYER).value.cashQ, 0);
        assertEq(vault.freeAtoms(BUYER), 0);

        // The short's loss is the long's gain; nothing is created or lost.
        assertEq(engine.account(SELLER).value.cashQ, int256(155e6) * 1e18);
        assertEq(engine.account(SELLER).value.lots, -int256(uint256(LOTS)));
        assertEq(engine.account(BIDDER).value.cashQ, int256(40e6) * 1e18);
        assertEq(engine.account(BIDDER).value.lots, int256(uint256(LOTS)));
        assertEq(token.balanceOf(address(vault)), 195e6);
        assertEq(engine.allocationQ(), 195e24);
    }
}
