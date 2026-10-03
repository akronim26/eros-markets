pragma solidity ^0.8.30;

import {Script} from "forge-std/Script.sol";
import {IPriceSource} from "../src/interfaces/IPriceSource.sol";
import {TestnetRiskSmoke} from "./ExerciseTestnetRiskBook.s.sol";

contract PrepareTestnetTrade is Script {
    bytes32 internal constant OBSERVATION_TYPEHASH = keccak256(
        "Observation(bytes32 marketId,bytes32 sourceId,uint64 sequence,uint64 observedAt,uint64 publishedAt,uint256 priceWad,uint256 impactBidWad,uint256 impactAskWad,uint256 bidDepthLots,uint256 askDepthLots,bytes32 sourceRulesHash,uint256 chainId,address engine)"
    );

    error InvalidTestnetPreparation();

    function prepare(
        address engine,
        bytes32 marketId,
        bytes32 sourceId,
        bytes32 rulesHash,
        uint64 firstSequence,
        uint64 latestAt
    ) external view returns (bytes memory callData) {
        if (
            block.chainid != 10143 || engine == address(0) || marketId == bytes32(0)
                || sourceId != keccak256("TESTNET_ONLY_SIGNED_INDEX")
                || rulesHash != keccak256("TESTNET_ONLY_INDEX_DEPTH_500_SPREAD_0_05") || firstSequence == 0
                || firstSequence > type(uint64).max - 10 || latestAt < 300
        ) revert InvalidTestnetPreparation();
        address signer = vm.envAddress("TESTNET_DEPLOYER");
        if (signer == address(0)) revert InvalidTestnetPreparation();
        IPriceSource.Observation[] memory observations = new IPriceSource.Observation[](11);
        bytes[] memory signatures = new bytes[](11);
        for (uint64 index; index < 11; ++index) {
            observations[index] = IPriceSource.Observation({
                marketId: marketId,
                sourceId: sourceId,
                sequence: firstSequence + index,
                observedAt: latestAt - 300 + index * 30,
                publishedAt: latestAt,
                priceWad: 5e17,
                impactBidWad: 49e16,
                impactAskWad: 51e16,
                bidDepthLots: 500,
                askDepthLots: 500,
                sourceRulesHash: rulesHash
            });
            signatures[index] = _sign(signer, digest(engine, observations[index]));
        }
        return abi.encodeCall(TestnetRiskSmoke.executeTrade, (observations, signatures));
    }

    function digest(address engine, IPriceSource.Observation memory observation)
        public
        view
        returns (bytes32)
    {
        return keccak256(abi.encode(OBSERVATION_TYPEHASH, observation, block.chainid, engine));
    }

    function _sign(address signer, bytes32 observationDigest) internal pure returns (bytes memory) {
        (uint8 recovery, bytes32 signatureR, bytes32 signatureS) = vm.sign(signer, observationDigest);
        return abi.encodePacked(signatureR, signatureS, recovery);
    }
}
