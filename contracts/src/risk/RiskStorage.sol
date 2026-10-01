// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;
import {LedgerMath as L} from "../math/LedgerMath.sol";
import {CoverageMath as C} from "../math/CoverageMath.sol";
import {PremiumMath as P} from "../math/PremiumMath.sol";
import {CollateralVault} from "../vaults/CollateralVault.sol";
import {ReserveVault} from "../vaults/ReserveVault.sol";
import {AccountingEvents} from "./AccountingEvents.sol";

abstract contract RiskStorage is AccountingEvents {
    enum Work {
        READY,
        ROLLOVER_SWEEP,
        FLOOR_SWEEP,
        HALT_SWEEP
    }

    struct Account {
        L.Value value;
        C.Orders orders;
        int256 fundingCheckpoint;
        uint256 deficit0;
        uint256 deficit1;
        uint256 premiumPaid;
        uint256 segmentPosted;
        int256 segmentCash;
        uint64 segmentStart;
        uint64 surchargeUntil;
        uint64 orderEpoch;
        uint64 positionVersion;
        uint64 reservationMarketEpoch;
        uint64 lastTouchedAt;
        uint64 feeChargedVersion;
    }

    struct Epoch {
        uint64 id;
        uint64 start;
        uint64 end;
        uint64 last;
        uint64 stop;
        int256 rate;
        bool stopped;
    }

    struct Context {
        uint64 at;
        uint64 freshThrough;
        uint64 version;
        uint256 markWad;
        bool markAvailable;
    }
    enum ActionKind {
        TRADE,
        RELEASE,
        TAKEOVER,
        LIQUIDATION,
        RESERVATION,
        RESERVE_UNWIND
    }

    struct Decision {
        ActionKind kind;
        address owner;
        address counterparty;
        L.Value beforeValue;
        L.Value afterValue;
        C.Orders afterOrders;
        uint64 cutoff;
        uint64 version;
        uint256 feesQ;
    }

    struct PairInput {
        address buyer;
        address seller;
        uint64 lots;
        uint16 tick;
        uint256 buyerFee;
        uint256 sellerFee;
        C.Orders buyerOrders;
        C.Orders sellerOrders;
    }
    CollateralVault public immutable collateralVault;
    ReserveVault public immutable reserveVault;
    address public immutable treasury;
    uint64 public immutable scheduledT;
    bool public immutable recoveryEnabled;
    bool public immutable fundingFeatureEnabled;
    mapping(address => Account) internal accounts;
    mapping(address => bool) public registered;
    address[] public participants;
    L.Value public reserve;
    uint256 public allocationQ;
    uint256 public protocolFeeQ;
    uint256 public keeperPayableQ;
    mapping(address => uint256) public keeperQ;
    uint256 public reserveCapBaseQ;
    uint256 public oiAllLots;
    uint256 public deficitSum0;
    uint256 public deficitSum1;
    uint256 public fundingCushionQ;
    uint256 public fundingBudgetQ;
    int256 public fundingFQ;
    int256 public fundingClearingQ;
    Epoch public epoch;
    P.Tariff public tariff;
    Work public work;
    uint64 public generation;
    uint64 public marketOrderEpoch;
    uint256 public cursor;
    uint256 public sweepCount;
    uint64 public sweepCutoff;
    bool public active;
    bool public halted;
    bool public fullBackingReconciled;
    bool public claimsEnabled;
    uint64 public economicHaltAt;
    uint64 public haltRecordedAt;
    uint64 public accrualCutoff;
    uint256 public oiHaltLots;
    uint256 internal entered;
    error Unauthorized();
    error BadState();
    error BadUnits();
    error Coverage();
    error Rejected();
    error Stale();
    modifier nonReentrant() {
        if (entered != 0) revert BadState();
        entered = 1;
        _;
        entered = 0;
    }

    constructor(CollateralVault vault, address treasury_, uint64 end, bool recovery_, bool funding_) {
        if (
            address(vault) == address(0) || treasury_ == address(0) || end < block.timestamp + 1 days
                || end > block.timestamp + 2588400
        ) revert BadUnits();
        collateralVault = vault;
        treasury = treasury_;
        scheduledT = end;
        recoveryEnabled = recovery_;
        fundingFeatureEnabled = funding_;
        reserveVault = new ReserveVault(address(this));
        marketOrderEpoch = 1;
    }

    function account(address owner) external view returns (Account memory) {
        return accounts[owner];
    }

    function participantCount() public view returns (uint256) {
        return participants.length;
    }

    function _clock() internal view returns (uint64) {
        if (block.timestamp > type(uint64).max) revert BadUnits();
        return uint64(block.timestamp);
    }
}
