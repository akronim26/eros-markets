pragma solidity ^0.8.30;

import {BookRiskEngine} from "@eros/engine/BookRiskEngine.sol";
import {CollateralVault} from "@eros/vaults/CollateralVault.sol";
import {Book} from "@eros/Book.sol";
import {IBookRiskHooks} from "@eros/interfaces/IBookRiskHooks.sol";
import {IPriceSource} from "@eros/interfaces/IPriceSource.sol";
import {RealMarketFixture} from "./RealMarketFixture.sol";
import {Outcome, RState, TrustSetInput} from "../../src/types/OracleTypes.sol";

/// @notice Local contract equivalent of E8. Source reports and assertion verdicts are fixtures;
/// this tests real factory/registry/oracle/accounting isolation, not external-service throughput.
contract RealOracleServiceScenariosTest is RealMarketFixture {
    function testFifteenRealMarketsShareTAndCompleteBoundedClaims() public {
        BookRiskEngine[15] memory engines;
        bytes32[15] memory ids;
        for (uint256 i; i < engines.length; ++i) {
            ids[i] = keccak256(abi.encode("real-e8", i));
            engines[i] = _listReal(ids[i], true);
            _fund(engines[i], buyer);
            _fund(engines[i], seller);
            vm.prank(gov);
            engines[i].activateMarket();
            assertEq(engines[i].listing().scheduledT, REAL_T);
        }
        // All markets consume their own signed observations over the same time interval.
        for (uint64 sequence = 1; sequence <= 31; ++sequence) {
            for (uint256 i; i < engines.length; ++i) {
                IPriceSource.Observation memory observation = _observation(engines[i], sequence);
                engines[i].submitObservation(observation, _sign(INDEX_KEY, engines[i].observationDigest(observation)));
            }
            if (sequence != 31) vm.warp(block.timestamp + 10);
        }
        for (uint256 i; i < engines.length; ++i) {
            vm.prank(seller);
            engines[i].placeOrder(Book.Place(IBookRiskHooks.OrderKind.LIMIT, false, false, 500, 100_000, 8, 0));
            vm.prank(buyer);
            engines[i].placeOrder(Book.Place(IBookRiskHooks.OrderKind.IOC, true, false, 500, 100_000, 8, 0));
            assertEq(engines[i].oiAllLots(), 100_000);
        }
        // Cross the 32-account page bound in one market while the others remain small.
        for (uint256 i; i < 33; ++i) {
            _fund(engines[0], address(uint160(50_000 + i)));
        }
        assertEq(engines[0].participantCount(), 35);

        (address forwarder, bytes memory metadata) = _configureForwarder();
        vm.warp(REAL_T + 60);
        for (uint256 i; i < engines.length; ++i) {
            resolutionOracle.requestResolution(ids[i]);
            _report(ids[i], i, forwarder, metadata);
            assertEq(engines[i].getHaltSnapshot().economicHaltAt, REAL_T);
        }

        for (uint256 i; i < engines.length; ++i) {
            _finalize(ids[i], true);
            assertEq(uint8(resolutionOracle.getResolution(ids[i]).state), uint8(RState.Final));
            assertFalse(engines[i].getSettlementStatus().claimsEnabled);
        }
        assertFalse(engines[0].prepareSnapshotChunk(32).done);
        assertEq(engines[0].getSettlementStatus().snapshotCursor, 32);
        // Work on one engine neither advances nor opens claims for any other engine.
        assertEq(engines[1].getSettlementStatus().snapshotCursor, 0);
        for (uint256 i; i < engines.length; ++i) {
            _prepare(engines[i]);
            assertEq(vault.claim(address(engines[i]), buyer), 150e6);
            assertEq(vault.claim(address(engines[i]), seller), 50e6);
            vm.expectRevert(CollateralVault.BadUnits.selector);
            vault.claim(address(engines[i]), buyer);
        }
        assertEq(vault.claim(address(engines[0]), address(50_000)), 100e6);
        assertEq(token.balanceOf(address(vault)), vault.recognizedAtoms());
    }

    function _configureForwarder() internal returns (address forwarder, bytes memory metadata) {
        bytes32 workflow = keccak256("local-e8-workflow");
        forwarder = makeAddr("local-e8-forwarder");
        address workflowOwner = makeAddr("local-e8-workflow-owner");
        TrustSetInput memory trust;
        trust.production = true;
        trust.forwarder = forwarder;
        trust.workflowIds = [workflow, bytes32(0)];
        trust.workflowOwner = workflowOwner;
        trust.runnerAttestor = vm.addr(ATTESTOR_KEY);
        trust.committee = committee;
        trust.threshold = 2;
        trust.watchdog = makeAddr("local-e8-watchdog");
        trust.venue = address(assertionVenue);
        vm.startPrank(gov);
        resolutionOracle.createTrustSet(trust);
        resolutionOracle.activateTrustSet(2);
        vm.stopPrank();

        metadata = abi.encodePacked(workflow, bytes10("eros-res"), workflowOwner, bytes2(0));
    }

    function _report(bytes32 id, uint256 index, address forwarder, bytes memory metadata) internal {
        bytes memory report = abi.encode(
            uint8(1),
            SELECTOR,
            address(resolutionOracle),
            id,
            uint8(Outcome.YES),
            uint64(block.timestamp),
            keccak256(abi.encode("local-e8-value", index)),
            registry.getSpecHash(id)
        );
        vm.prank(forwarder);
        resolutionOracle.onReport(metadata, report);
    }
}
