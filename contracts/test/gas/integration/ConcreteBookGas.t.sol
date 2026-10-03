pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {Book} from "../../../src/Book.sol";
import {BookRiskEngine} from "../../../src/engine/BookRiskEngine.sol";
import {IBookRiskHooks} from "../../../src/interfaces/IBookRiskHooks.sol";
import {IMarketConfig} from "../../../src/interfaces/IMarketConfig.sol";
import {IPriceSource} from "../../../src/interfaces/IPriceSource.sol";
import {CollateralVault} from "../../../src/vaults/CollateralVault.sol";
import {MockUSDC} from "../../mocks/A/MockUSDC.sol";
import {MockResolutionAuthority} from "../../mocks/B/MockResolutionAuthority.sol";
import {ListingFixture} from "../../risk/B/B019.t.sol";

abstract contract ConcreteBookGasFixture is Test {
    uint256 internal constant SIGNER_KEY = 0x516;
    address internal constant TAKER = address(0x101);
    uint64 internal constant MAKER_LOTS = 1000;
    uint256 internal constant CALL_GAS_BUDGET = 29_500_000;
    BookRiskEngine internal engine;
    CollateralVault internal vault;
    MockUSDC internal token;
    MockResolutionAuthority internal authority;

    function setUp() public virtual {
        vm.warp(1_000_000);
        token = new MockUSDC();
        vault = new CollateralVault(address(token), address(this));
        authority = new MockResolutionAuthority();
        IMarketConfig.Listing memory configuration = ListingFixture.make(
            uint64(block.timestamp), address(authority), address(0x3031), address(this), vm.addr(SIGNER_KEY)
        );
        configuration.token = address(token);
        configuration.deploymentCapX = 1;
        configuration.fundingEnabled = false;
        configuration.maxLiqLotsPerBlock = 0;
        engine = new BookRiskEngine(vault, address(0x777), configuration);
        vault.registerEngine(address(engine));
        authority.bind(engine);
        _fund(TAKER, 100e6);
        for (uint256 index; index < 64; ++index) {
            _fund(address(uint160(10_000 + index)), 1e6);
        }
        engine.activateMarket();
        for (uint64 sequence = 1; sequence <= 31; ++sequence) {
            IPriceSource.Observation memory observation = IPriceSource.Observation({
                marketId: configuration.marketId,
                sourceId: configuration.indexSourceId,
                sequence: sequence,
                observedAt: uint64(block.timestamp),
                publishedAt: uint64(block.timestamp),
                priceWad: 5e17,
                impactBidWad: 49e16,
                impactAskWad: 51e16,
                bidDepthLots: configuration.depthNLots,
                askDepthLots: configuration.depthNLots,
                sourceRulesHash: configuration.indexRulesHash
            });
            (uint8 recovery, bytes32 signatureR, bytes32 signatureS) =
                vm.sign(SIGNER_KEY, engine.observationDigest(observation));
            engine.submitObservation(observation, abi.encodePacked(signatureR, signatureS, recovery));
            if (sequence != 31) vm.warp(block.timestamp + 10);
        }
        for (uint256 index; index < 64; ++index) {
            vm.prank(address(uint160(10_000 + index)));
            engine.placeOrder(
                Book.Place(
                    IBookRiskHooks.OrderKind.POST_ONLY,
                    false,
                    false,
                    500,
                    MAKER_LOTS,
                    0,
                    uint32(block.number + 1)
                )
            );
        }
    }

    function _fund(address owner, uint256 atoms) internal {
        token.mint(owner, atoms);
        vm.startPrank(owner);
        token.approve(address(vault), atoms);
        vault.deposit(atoms);
        vault.allocate(address(engine), atoms, false);
        vm.stopPrank();
    }

    function _buyPage() internal {
        vm.prank(TAKER);
        engine.placeOrder(Book.Place(IBookRiskHooks.OrderKind.IOC, true, false, 500, 64 * MAKER_LOTS, 8, 0));
    }

    function _buyAll() internal {
        for (uint256 page; page < 8; ++page) {
            _buyPage();
        }
    }
}

contract ConcreteBookGasTest is ConcreteBookGasFixture {
    function testGasConfiguredMakerFillCallFitsBudget() public {
        uint256 beforeGas = gasleft();
        _buyPage();
        uint256 callGas = beforeGas - gasleft();
        emit log_named_uint("concrete_8_maker_fill_call_gas", callGas);
        assertLt(callGas, CALL_GAS_BUDGET);
        assertEq(engine.oiAllLots(), 8 * MAKER_LOTS);
        assertEq(int256(engine.account(TAKER).value.lots), int256(uint256(8 * MAKER_LOTS)));
        for (uint256 index; index < 64; ++index) {
            address maker = address(uint160(10_000 + index));
            assertEq(
                int256(engine.account(maker).value.lots), index < 8 ? -int256(uint256(MAKER_LOTS)) : int256(0)
            );
            assertEq(engine.account(maker).orders.askLots, index < 8 ? 0 : MAKER_LOTS);
        }
        (uint16 bid, uint16 ask) = engine.bestBidAsk();
        assertEq(bid, 0);
        assertEq(ask, 500);
    }

    function testGasConfiguredExpiredMakerPrunesFitBudget() public {
        vm.roll(block.number + 2);
        uint256 beforeGas = gasleft();
        _buyPage();
        uint256 callGas = beforeGas - gasleft();
        emit log_named_uint("concrete_8_expired_prune_call_gas", callGas);
        assertLt(callGas, CALL_GAS_BUDGET);
        assertEq(engine.oiAllLots(), 0);
        assertEq(engine.account(TAKER).value.lots, 0);
        for (uint256 index; index < 64; ++index) {
            address maker = address(uint160(10_000 + index));
            assertEq(engine.account(maker).value.lots, 0);
            assertEq(engine.account(maker).orders.askLots, index < 8 ? 0 : MAKER_LOTS);
        }
    }

    function testOversizedSweepRejectedWithoutAccountOrBookMutation() public {
        vm.prank(TAKER);
        vm.expectRevert(Book.BadMaxFills.selector);
        engine.placeOrder(Book.Place(IBookRiskHooks.OrderKind.IOC, true, false, 500, 64 * MAKER_LOTS, 64, 0));
        assertEq(engine.oiAllLots(), 0);
        assertEq(engine.account(TAKER).orders.bidLots, 0);
        assertEq(engine.getLevel(false, 500).size, 64 * MAKER_LOTS);
    }

    function testEightBoundedSweepsCompleteSixtyFourMakerBook() public {
        for (uint256 page; page < 8; ++page) {
            uint256 beforeGas = gasleft();
            _buyPage();
            assertLt(beforeGas - gasleft(), CALL_GAS_BUDGET);
        }
        assertEq(engine.oiAllLots(), 64 * MAKER_LOTS);
        assertEq(engine.getLevel(false, 500).size, 0);
        assertEq(engine.account(TAKER).orders.bidLots, 0);
    }
}

contract ConcreteBookSettlementGasTest is ConcreteBookGasFixture {
    function setUp() public override {
        super.setUp();
        _buyAll();
        authority.haltEarly();
        authority.finalize(1);
    }

    function testGasFirstSnapshotPageFitsBudget() public {
        uint256 beforeGas = gasleft();
        engine.prepareSnapshotChunk(32);
        uint256 callGas = beforeGas - gasleft();
        emit log_named_uint("concrete_snapshot_32_call_gas", callGas);
        assertLt(callGas, CALL_GAS_BUDGET);
        assertFalse(engine.claimsEnabled());
    }
}
