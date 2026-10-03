// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;
import {RiskStorage} from "./RiskStorage.sol";
import {AccountingState} from "../math/MathTypes.sol";

abstract contract AccountRegistry is RiskStorage {
    function _register(address owner) internal {
        if (registered[owner]) return;
        if (owner == address(0) || work != AccountingState.READY || halted || participants.length == 1024) {
            revert BadState();
        }
        registered[owner] = true;
        participants.push(owner);
        participantId[owner] = uint32(participants.length);
        Account storage a = accounts[owner];
        a.fundingCheckpoint = fundingFQ;
        a.orderEpoch = 1;
        a.reservationMarketEpoch = marketOrderEpoch;
        a.segmentStart = _clock();
        emit AccountRegistered(owner, participants.length - 1);
    }
}
