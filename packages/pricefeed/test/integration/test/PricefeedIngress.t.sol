// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {FeedHarness} from "../src/FeedHarness.sol";
import {IPriceSource} from "../../../../../contracts/src/interfaces/IPriceSource.sol";
import {PriceIngress} from "../../../../../contracts/src/pricing/PriceIngress.sol";

contract PricefeedIngressTest is Test {
    address constant ENGINE = 0x1111111111111111111111111111111111111111;
    string private fixture;
    FeedHarness private engine;

    function setUp() public {
        vm.chainId(31337);
        vm.warp(10_000);
        fixture = vm.readFile("../../fixtures/wire.json");
        FeedHarness implementation = new FeedHarness();
        vm.etch(ENGINE, address(implementation).code);
        engine = FeedHarness(ENGINE);
        engine.initialize(
            bytes32(uint256(0x0101010101010101010101010101010101010101010101010101010101010101)),
            bytes32(uint256(0x0202020202020202020202020202020202020202020202020202020202020202)),
            vm.parseJsonAddress(fixture, ".signerAddress"),
            bytes32(uint256(0x0303030303030303030303030303030303030303030303030303030303030303))
        );
    }

    function packet(string memory path) private view returns (IPriceSource.Observation memory o, bytes memory signature, bytes32 digest) {
        string memory p = string.concat(path, ".obs.");
        o.marketId = vm.parseJsonBytes32(fixture, string.concat(p, "marketId"));
        o.sourceId = vm.parseJsonBytes32(fixture, string.concat(p, "sourceId"));
        o.sequence = uint64(vm.parseJsonUint(fixture, string.concat(p, "sequence")));
        o.observedAt = uint64(vm.parseJsonUint(fixture, string.concat(p, "observedAt")));
        o.publishedAt = uint64(vm.parseJsonUint(fixture, string.concat(p, "publishedAt")));
        o.priceWad = vm.parseJsonUint(fixture, string.concat(p, "priceWad"));
        o.impactBidWad = vm.parseJsonUint(fixture, string.concat(p, "impactBidWad"));
        o.impactAskWad = vm.parseJsonUint(fixture, string.concat(p, "impactAskWad"));
        o.bidDepthLots = vm.parseJsonUint(fixture, string.concat(p, "bidDepthLots"));
        o.askDepthLots = vm.parseJsonUint(fixture, string.concat(p, "askDepthLots"));
        o.sourceRulesHash = vm.parseJsonBytes32(fixture, string.concat(p, "sourceRulesHash"));
        signature = vm.parseJsonBytes(fixture, string.concat(path, ".signature"));
        digest = vm.parseJsonBytes32(fixture, string.concat(path, ".digest"));
    }

    function test_tsRawDigestAndSignatureEnterActualIngress() public {
        (IPriceSource.Observation memory o, bytes memory signature, bytes32 digest) = packet(".observation");
        assertEq(engine.observationDigest(o), digest);
        vm.expectEmit(true, false, false, true, ENGINE);
        emit IPriceSource.ObservationAccepted(o.sourceId, o.sequence, o.observedAt, o.publishedAt, 10_000, 6e17, true, digest);
        engine.submitObservation(o, signature);
        assertEq(engine.sourceState(o.sourceId).lastSequence, 1);
        (bool available,, uint256 covered,) = engine.indexTwap300(10_000);
        assertFalse(available);
        assertEq(covered, 10);
    }

    function test_wrongDomainAndMutatedFieldRejectedByActualIngress() public {
        (IPriceSource.Observation memory o, bytes memory signature,) = packet(".observation");
        vm.chainId(31338);
        vm.expectRevert(PriceIngress.BadSignature.selector);
        engine.submitObservation(o, signature);
        vm.chainId(31337);
        o.askDepthLots++;
        vm.expectRevert(PriceIngress.BadSignature.selector);
        engine.submitObservation(o, signature);
    }

    function test_duplicatePacketRejectedByActualIngress() public {
        (IPriceSource.Observation memory o, bytes memory signature,) = packet(".observation");
        engine.submitObservation(o, signature);
        vm.expectRevert(PriceIngress.DuplicateOrOldSequence.selector);
        engine.submitObservation(o, signature);
    }

    function test_fullCoveredWindowAndInvalidTransitionUseActualStore() public {
        for (uint256 i; i < 11; ++i) {
            (IPriceSource.Observation memory o, bytes memory signature, bytes32 digest) = packet(string.concat(".series[", vm.toString(i), "]"));
            assertEq(engine.observationDigest(o), digest);
            engine.submitObservation(o, signature);
        }
        (bool available, uint256 price, uint256 covered,) = engine.indexTwap300(10_000);
        assertTrue(available);
        assertEq(price, 6e17);
        assertEq(covered, 300);
        (IPriceSource.Observation memory invalid, bytes memory signature, bytes32 digest) = packet(".invalid");
        vm.expectEmit(true, false, false, true, ENGINE);
        emit IPriceSource.ObservationAccepted(invalid.sourceId, invalid.sequence, invalid.observedAt, invalid.publishedAt, 10_000, 0, false, digest);
        engine.submitObservation(invalid, signature);
        (available,, covered,) = engine.indexTwap300(10_010);
        assertFalse(available);
        assertEq(covered, 290);
    }
}
