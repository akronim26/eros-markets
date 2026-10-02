// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {SafeTransferLib} from "solady/utils/SafeTransferLib.sol";
import {IAssertionVenue} from "../interfaces/IAssertionVenue.sol";
import {IOptimisticOracleV3, IOptimisticOracleV3CallbackRecipient} from "../interfaces/IOptimisticOracleV3.sol";

/// @title UmaAdapter — same-chain UMA OOv3 venue (Oracle spec §7.1–7.4; audit EM-01 / D-09).
/// @notice OOv3 pulls the bond from msg.sender (this adapter) and pays it back to `asserter`. The adapter is
///         the OOv3 callbackRecipient, but callbacks only record and NEVER revert: a reverting callback would
///         block disputes and settlement for good. ResolutionOracle reads status from OOv3 itself.
contract UmaAdapter is IAssertionVenue, IOptimisticOracleV3CallbackRecipient {
    using SafeTransferLib for address;

    error OnlyOracle();
    error OnlyTreasury();
    error UnknownAssertion();

    IOptimisticOracleV3 public immutable oov3;
    address public immutable usdc;
    address public immutable oracle; // pinned ResolutionOracle
    address public immutable treasury; // BondTreasury (dispute channel)
    bytes32 public immutable identifier; // ASSERT_TRUTH

    mapping(bytes32 assertionId => bytes32 marketId) internal _market;
    mapping(bytes32 assertionId => bool) public disputeSeen; // callback record (UI only)
    mapping(bytes32 assertionId => bool) public resolveSeen; // callback record (UI only)

    event VenueAsserted(
        bytes32 indexed marketId, bytes32 indexed assertionId, address asserter, uint256 bond, uint64 liveness
    );
    event VenueDisputed(bytes32 indexed marketId, bytes32 indexed assertionId);
    event VenueResolved(bytes32 indexed marketId, bytes32 indexed assertionId, bool truthful);

    constructor(IOptimisticOracleV3 oov3_, address usdc_, address oracle_, address treasury_) {
        oov3 = oov3_;
        usdc = usdc_;
        oracle = oracle_;
        treasury = treasury_;
        identifier = oov3_.defaultIdentifier();
    }

    function assertOutcome(AssertRequest calldata r) external returns (bytes32 assertionId) {
        if (msg.sender != oracle) revert OnlyOracle();
        // Safe (plan C.1): only the pinned oracle reaches this, with payer = the treasury or the permissionless
        // caller who approved this adapter for exactly the bond.
        // forge-lint: disable-next-line(arbitrary-send-erc20)
        usdc.safeTransferFrom(r.payer, address(this), r.bond); // payer approved the adapter for exactly `bond`
        usdc.safeApprove(address(oov3), r.bond);
        assertionId = oov3.assertTruth(
            r.claim, r.asserter, address(this), address(0), r.liveness, usdc, r.bond, identifier, r.marketId
        );
        _market[assertionId] = r.marketId;
        emit VenueAsserted(r.marketId, assertionId, r.asserter, r.bond, r.liveness);
    }

    function trySettle(bytes32 assertionId) external returns (bool settledNow) {
        IOptimisticOracleV3.Assertion memory a = oov3.getAssertion(assertionId);
        if (a.asserter == address(0) || a.settled) return false;
        try oov3.settleAssertion(assertionId) {
            return true;
        } catch {
            return false; // liveness not over, or DVM has not answered (possibly never: deleted request)
        }
    }

    function disputeFor(bytes32 assertionId, address payer, address disputer) external {
        if (msg.sender != treasury) revert OnlyTreasury();
        IOptimisticOracleV3.Assertion memory a = oov3.getAssertion(assertionId);
        if (a.asserter == address(0)) revert UnknownAssertion();
        // Safe (plan C.1): only the treasury reaches this, paying its own dispute bond (payer = treasury).
        // forge-lint: disable-next-line(arbitrary-send-erc20)
        usdc.safeTransferFrom(payer, address(this), a.bond);
        usdc.safeApprove(address(oov3), a.bond);
        oov3.disputeAssertion(assertionId, disputer);
    }

    // ------------------------------------------------------------ OOv3 callbacks: record only, never revert

    function assertionDisputedCallback(bytes32 assertionId) external {
        if (msg.sender != address(oov3)) return;
        disputeSeen[assertionId] = true;
        emit VenueDisputed(_market[assertionId], assertionId);
    }

    function assertionResolvedCallback(bytes32 assertionId, bool truthful) external {
        if (msg.sender != address(oov3)) return;
        resolveSeen[assertionId] = true;
        emit VenueResolved(_market[assertionId], assertionId, truthful);
    }

    // ------------------------------------------------------------ views

    function statusOf(bytes32 assertionId) external view returns (AssertionStatus memory s) {
        IOptimisticOracleV3.Assertion memory a = oov3.getAssertion(assertionId);
        s.exists = a.asserter != address(0);
        s.disputed = a.disputer != address(0);
        s.settled = a.settled;
        s.truthful = a.settled && a.settlementResolution;
        s.expiresAt = a.expirationTime;
        s.asserter = a.asserter;
        s.disputer = a.disputer;
        s.bond = a.bond;
    }

    function marketOf(bytes32 assertionId) external view returns (bytes32) {
        return _market[assertionId];
    }

    function minimumBond() external view returns (uint256) {
        return oov3.getMinimumBond(usdc);
    }

    function bondCurrency() external view returns (address) {
        return usdc;
    }
}
