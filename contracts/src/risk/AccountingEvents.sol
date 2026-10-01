// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

abstract contract AccountingEvents {
    event AccountRegistered(address indexed owner, uint256 indexed index);
    event CashAllocated(address indexed owner, uint256 atoms, int256 cashQ);
    event AccountSynced(address indexed owner, int256 fundingPaymentQ, uint256 premiumQ, uint64 cutoff);
    event PairedPosting(
        address indexed buyer, address indexed seller, uint64 lots, uint16 tick, uint256 feesQ
    );
    event FundingAdvanced(
        int256 fundingFQ, uint256 flowQ, int256 reservePaymentQ, uint64 cutoff, bool stopped
    );
    event EpochOpened(uint64 indexed epoch, uint64 start, uint64 end, int256 rateQPerLotSec, uint256 budgetQ);
    event SweepProgress(uint8 kind, uint64 generation, uint256 cursor, uint256 count);
    event AccountTakenOver(address indexed owner, int128 lots, int256 cashQ, uint64 cutoff);
    event EconomicHalt(uint64 economicHaltAt, uint64 recordedAt, uint64 accrualCutoff, uint256 oiHaltLots);
    event ClaimsPrepared(uint256 traderAtoms, uint256 reserveResidualQ);
    event AccountBalance(address indexed owner, int128 positionLots, int256 cashQ, int256 fundingCheckpointQ);
    event MarketBalance(
        uint256 allocationQ,
        int128 reserveLots,
        int256 reserveCashQ,
        uint256 protocolFeeQ,
        uint256 keeperPayableQ,
        int256 fundingClearingQ,
        uint256 fundingCushionQ,
        uint256 fundingBudgetQ,
        uint256 oiAllLots
    );
}
