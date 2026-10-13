// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

/// @title IAssertionVenue
/// @notice The only surface ResolutionOracle uses to post and read bonded assertions (Oracle spec §7.1).
///         The venue (UMA OOv3 same-chain today; a cross-chain relay later) can change without touching
///         the state machine. Status is always read from the venue's source of truth, never inferred from
///         callbacks (audit EM-01 / D-09).
interface IAssertionVenue {
    struct AssertRequest {
        bytes32 marketId; // also the OOv3 domainId
        bytes claim; // rendered standalone claim (§7.3)
        address asserter; // receives the bond back if true: BondTreasury (team paths) or the caller (permissionless)
        address payer; // who funds the bond now: BondTreasury or the permissionless caller
        uint64 liveness;
        uint256 bond; // USDC atoms
    }

    struct AssertionStatus {
        bool exists;
        bool disputed;
        bool settled;
        bool truthful; // meaningful only when settled
        uint64 expiresAt; // liveness end
        address asserter;
        address disputer;
        uint256 bond;
    }

    /// @notice Only the pinned ResolutionOracle. Pulls `bond` from `payer` and posts the assertion.
    function assertOutcome(AssertRequest calldata req) external returns (bytes32 assertionId);

    /// @notice Anyone. Settles on the venue if possible (liveness over, or DVM answered). Never reverts:
    ///         returns false when the venue cannot settle yet (e.g. DVM vote pending or deleted).
    function trySettle(bytes32 assertionId) external returns (bool settledNow);

    /// @notice Only BondTreasury: dispute with treasury float; winnings return to `disputer`.
    function disputeFor(bytes32 assertionId, address payer, address disputer) external;

    function statusOf(bytes32 assertionId) external view returns (AssertionStatus memory);

    function marketOf(bytes32 assertionId) external view returns (bytes32);

    /// @notice Venue minimum bond for the bond currency (UMA: finalFee / burnedBondPercentage).
    function minimumBond() external view returns (uint256);

    function bondCurrency() external view returns (address);
}
