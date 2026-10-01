// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test, Vm} from "forge-std/Test.sol";
import {PriceIngress} from "../../../src/pricing/PriceIngress.sol";
import {IPriceSource} from "../../../src/interfaces/IPriceSource.sol";

contract IngressHarness is PriceIngress {
    struct Rec {
        uint64 t;
        uint256 mid;
        bool valid;
    }

    Rec[] public recs;

    constructor(bytes32 marketId, bytes32 indexSource, address signer, bytes32 rules) {
        _initIngress(marketId, indexSource, DepthRule(500, 5e16));
        _configureSource(indexSource, signer, rules);
    }

    function configure(bytes32 id, address signer, bytes32 rules) external {
        _configureSource(id, signer, rules);
    }

    function _onIndexObservation(uint64 t, uint256 mid, bool valid) internal override {
        recs.push(Rec(t, mid, valid));
    }

    function count() external view returns (uint256) {
        return recs.length;
    }
}

/// B016: authenticated observation ingress.
contract B016Test is Test {
    bytes32 constant MKT = keccak256("market-1");
    bytes32 constant SRC = keccak256("index-source");
    bytes32 constant RULES = keccak256("rules-v1");
    uint256 constant PK = 0xA11CE;
    IngressHarness h;
    address signer;

    function setUp() public {
        signer = vm.addr(PK);
        h = new IngressHarness(MKT, SRC, signer, RULES);
        vm.warp(10_000);
    }

    function obs(uint64 seq, uint64 observedAt, uint64 publishedAt)
        internal
        pure
        returns (IPriceSource.Observation memory o)
    {
        o = IPriceSource.Observation(
            MKT, SRC, seq, observedAt, publishedAt, 6e17, 59e16, 61e16, 500, 500, RULES
        );
    }

    function sign(IPriceSource.Observation memory o, uint256 pk) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, h.observationDigest(o));
        return abi.encodePacked(r, s, v);
    }

    function test_acceptsValidAndRecordsObservedAt() public {
        IPriceSource.Observation memory o = obs(1, 9_990, 9_995);
        h.submitObservation(o, sign(o, PK));
        (uint64 t, uint256 mid, bool valid) = h.recs(0);
        assertEq(t, 9_990, "freshness clock is observedAt");
        assertEq(mid, 6e17);
        assertTrue(valid);
        assertEq(h.sourceState(SRC).lastSequence, 1);
    }

    function test_wrongSignerFails() public {
        IPriceSource.Observation memory o = obs(1, 9_990, 9_995);
        bytes memory sig = sign(o, 0xB0B);
        vm.expectRevert(PriceIngress.BadSignature.selector);
        h.submitObservation(o, sig);
    }

    function test_wrongDomainFails() public {
        // Signature made for another engine address (same chain) does not verify here.
        IngressHarness other = new IngressHarness(MKT, SRC, signer, RULES);
        IPriceSource.Observation memory o = obs(1, 9_990, 9_995);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(PK, other.observationDigest(o));
        vm.expectRevert(PriceIngress.BadSignature.selector);
        h.submitObservation(o, abi.encodePacked(r, s, v));
        // and another chain id
        bytes memory sig = sign(o, PK);
        vm.chainId(999);
        vm.expectRevert(PriceIngress.BadSignature.selector);
        h.submitObservation(o, sig);
    }

    function test_wrongMarketOrSourceFails() public {
        IPriceSource.Observation memory o = obs(1, 9_990, 9_995);
        o.marketId = keccak256("other");
        bytes memory sig = sign(o, PK);
        vm.expectRevert(PriceIngress.WrongMarket.selector);
        h.submitObservation(o, sig);
        o = obs(1, 9_990, 9_995);
        o.sourceId = keccak256("unknown");
        sig = sign(o, PK);
        vm.expectRevert(PriceIngress.UnknownSource.selector);
        h.submitObservation(o, sig);
        o = obs(1, 9_990, 9_995);
        o.sourceRulesHash = keccak256("rules-v2");
        sig = sign(o, PK);
        vm.expectRevert(PriceIngress.UnknownSource.selector);
        h.submitObservation(o, sig);
    }

    function test_duplicateAndBackwardsSequenceFail() public {
        IPriceSource.Observation memory o = obs(5, 9_990, 9_995);
        h.submitObservation(o, sign(o, PK));
        bytes memory again = sign(o, PK);
        vm.expectRevert(PriceIngress.DuplicateOrOldSequence.selector);
        h.submitObservation(o, again);
        IPriceSource.Observation memory older = obs(4, 9_991, 9_995);
        bytes memory sig = sign(older, PK);
        vm.expectRevert(PriceIngress.DuplicateOrOldSequence.selector);
        h.submitObservation(older, sig);
    }

    function test_backwardsTimeFails() public {
        IPriceSource.Observation memory o = obs(1, 9_990, 9_995);
        h.submitObservation(o, sign(o, PK));
        IPriceSource.Observation memory back = obs(2, 9_989, 9_995);
        bytes memory sig = sign(back, PK);
        vm.expectRevert(PriceIngress.BackwardsObservation.selector);
        h.submitObservation(back, sig);
    }

    function test_futureObservationFails() public {
        IPriceSource.Observation memory o = obs(1, 10_000, 10_001);
        bytes memory sig = sign(o, PK);
        vm.expectRevert(PriceIngress.FutureTimestamp.selector);
        h.submitObservation(o, sig);
        o = obs(1, 10_002, 10_001);
        sig = sign(o, PK);
        vm.expectRevert(PriceIngress.BadTimestampOrder.selector);
        h.submitObservation(o, sig);
        // exactly now is accepted (tolerance zero, not negative)
        o = obs(1, 10_000, 10_000);
        h.submitObservation(o, sign(o, PK));
    }

    function test_delayedObservationKeepsItsObservedAt() public {
        IPriceSource.Observation memory o = obs(1, 9_000, 9_001); // accepted 1,000 s later
        h.submitObservation(o, sign(o, PK));
        (uint64 t,,) = h.recs(0);
        assertEq(t, 9_000, "not re-stamped with acceptedAt");
    }

    function test_thinDepthRecordedInvalid() public {
        IPriceSource.Observation memory o = obs(1, 9_990, 9_995);
        o.bidDepthLots = 499;
        h.submitObservation(o, sign(o, PK));
        (,, bool valid) = h.recs(0);
        assertFalse(valid);
    }

    function test_priceMustMatchDepthMid() public {
        IPriceSource.Observation memory o = obs(1, 9_990, 9_995);
        o.priceWad = 61e16;
        bytes memory sig = sign(o, PK);
        vm.expectRevert(PriceIngress.BadPrice.selector);
        h.submitObservation(o, sig);
    }

    function test_sourcePinnedOnce() public {
        vm.expectRevert(PriceIngress.SourceAlreadyConfigured.selector);
        h.configure(SRC, address(0xBEEF), RULES);
    }

    function test_eventCarriesAllClocks() public {
        IPriceSource.Observation memory o = obs(1, 9_990, 9_995);
        bytes memory sig = sign(o, PK);
        vm.recordLogs();
        h.submitObservation(o, sig);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(logs.length, 1);
        (uint64 seq, uint64 oa, uint64 pa, uint64 aa,,,) =
            abi.decode(logs[0].data, (uint64, uint64, uint64, uint64, uint256, bool, bytes32));
        assertEq(seq, 1);
        assertEq(oa, 9_990);
        assertEq(pa, 9_995);
        assertEq(aa, 10_000);
    }
}
