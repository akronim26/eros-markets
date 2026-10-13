// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Script, console2} from "forge-std/Script.sol";
import {MarketCore, PanelResult, Phase, ReviewedProposal, Resolution, RState, Sig} from "../../src/types/OracleTypes.sol";
import {MarketRegistry} from "../../src/MarketRegistry.sol";
import {ResolutionOracle} from "../../src/ResolutionOracle.sol";

interface IMonitoredEngine {
    function requestReduceOnly(bytes32 reason) external;
}

/// @title ResolveNativeEarly (NM-H01 / NM-H02)
/// @notice Early YES resolution of a listed market through the existing ResolutionOracle route,
///         for an event that has ALREADY happened before T (the market rules must allow early YES).
///         STAGE=propose: monitor restricts the engine and requests the early check; the runner
///           attestor's signed panel result (unanimous, confident YES) moves it to EarlyReview; two
///           committee members sign the reviewed YES proposal; the proposal is asserted (bond from
///           the BondTreasury) on the sandbox UMA venue.
///         STAGE=finalize: after the assertion liveness, finalizeMarket settles the engine.
///         Signed messages are submitted by the payer key; only monitor calls use the monitor key.
///         This drives the sandbox adjudication path; it is not a decentralized oracle outcome.
///
/// Env: STAGE, MARKET_ID, EVIDENCE_URI, EVIDENCE_HASH, PAYER_KEY, MONITOR_KEY, ATTESTOR_KEY,
///      COMMITTEE_A_KEY, COMMITTEE_B_KEY (signers sorted ascending inside), REGISTRY.
contract ResolveNativeEarly is Script {
    function run() external {
        MarketRegistry reg = MarketRegistry(vm.envAddress("REGISTRY"));
        ResolutionOracle oracle = ResolutionOracle(reg.oracle());
        bytes32 id = vm.envBytes32("MARKET_ID");
        uint256 payer = vm.envUint("PAYER_KEY");
        string memory stage = vm.envString("STAGE");

        if (keccak256(bytes(stage)) == keccak256("finalize")) {
            vm.startBroadcast(payer);
            oracle.finalizeMarket(id);
            vm.stopBroadcast();
            Resolution memory f = oracle.getResolution(id);
            console2.log("state", uint8(f.state), "outcome", uint8(f.outcome));
            return;
        }
        require(keccak256(bytes(stage)) == keccak256("propose"), "STAGE must be propose|finalize");
        MarketCore memory core = reg.getMarketCore(id);
        string memory uri = vm.envString("EVIDENCE_URI");
        bytes32 evidence = vm.envBytes32("EVIDENCE_HASH");

        // 1. Monitor: restrict the engine, then request the early check.
        vm.startBroadcast(vm.envUint("MONITOR_KEY"));
        IMonitoredEngine(core.engine).requestReduceOnly(keccak256(bytes(string.concat("event observed: ", uri))));
        oracle.requestEarlyCheck(id);
        vm.stopBroadcast();

        // 2. Panel result (EARLY phase, unanimous confident YES), signed by the runner attestor.
        Resolution memory r = oracle.getResolution(id);
        PanelResult memory p;
        p.marketId = id;
        p.phase = uint8(Phase.EARLY);
        p.attempt = r.attempts;
        p.labels = [uint8(1), uint8(1), uint8(1)];
        p.calibratedBps = [uint16(9500), uint16(9500), uint16(9500)];
        p.evidenceHash = evidence;
        p.evidenceURIHash = keccak256(bytes(uri));
        p.gateHash = core.gateHash;
        p.trustSetId = r.trustSetId == 0 ? oracle.activeTrustSetId() : r.trustSetId;
        p.deadline = uint64(block.timestamp + 1 hours);
        bytes memory attestation = _sign(vm.envUint("ATTESTOR_KEY"), oracle.hashPanelResult(p));
        vm.startBroadcast(payer);
        oracle.submitPanelResult(id, p, uri, attestation);
        vm.stopBroadcast();
        r = oracle.getResolution(id);
        require(r.state == RState.EarlyReview, "NOT_IN_EARLY_REVIEW");

        // 3. Reviewed YES proposal signed by two committee members (ascending signer order).
        ReviewedProposal memory q;
        q.marketId = id;
        q.outcome = 1; // Outcome.YES
        q.evidenceHash = evidence;
        q.evidenceURIHash = keccak256(bytes(uri));
        q.noteHash = keccak256(bytes(string.concat("Early YES: ", uri)));
        q.attempt = r.attempts;
        q.rejectedMask = r.rejectedMask;
        q.early = true;
        q.trustSetId = oracle.activeTrustSetId();
        q.deadline = uint64(block.timestamp + 1 hours);
        bytes32 digest = oracle.hashReviewedProposal(q);
        uint256 a = vm.envUint("COMMITTEE_A_KEY");
        uint256 b = vm.envUint("COMMITTEE_B_KEY");
        if (vm.addr(a) > vm.addr(b)) (a, b) = (b, a);
        Sig[] memory sigs = new Sig[](2);
        sigs[0] = Sig(vm.addr(a), _sign(a, digest));
        sigs[1] = Sig(vm.addr(b), _sign(b, digest));

        // 4. Submit and assert (bond from the treasury) on the configured venue.
        vm.startBroadcast(payer);
        oracle.submitReviewedProposal(id, q, uri, sigs);
        oracle.assertProposal(id);
        vm.stopBroadcast();
        r = oracle.getResolution(id);
        console2.log("state", uint8(r.state), "proposed", uint8(r.proposed));
        console2.logBytes32(r.assertionId);
    }

    function _sign(uint256 key, bytes32 digest) internal pure returns (bytes memory) {
        (uint8 v, bytes32 rr, bytes32 ss) = vm.sign(key, digest);
        return abi.encodePacked(rr, ss, v);
    }
}
