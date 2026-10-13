import { parseAbi } from "viem";

/** NativeOutcomeVault (contracts/src/native/NativeOutcomeVault.sol): complete-set issuance and redemption. */
export const nativeVaultAbi = parseAbi([
  "function engine() view returns (address)",
  "function yes() view returns (address)",
  "function no() view returns (address)",
  "function collateral() view returns (address)",
  "function marketId() view returns (bytes32)",
  "function scheduledT() view returns (uint64)",
  "function resolved() view returns (bool)",
  "function finalOutcome() view returns (uint8)",
  "function payoutYesWad() view returns (uint256)",
  "function outstandingSets() view returns (uint256)",
  "function totalRedeemedAtoms() view returns (uint256)",
  "function issuanceOpen() view returns (bool)",
  "function redeemValue(uint256 yesAtoms, uint256 noAtoms) view returns (uint256)",
  "function syncResolution() returns (uint256)",
  "function redeem(uint256 yesAtoms, uint256 noAtoms, address receiver) returns (uint256 paid)",
  "event ResolutionSynced(uint8 outcome, uint256 payoutYesWad, bytes32 snapshotId, uint256 outstandingSets)",
  "event Redeemed(address indexed owner, address indexed receiver, uint256 yesAtoms, uint256 noAtoms, uint256 paid)",
  "error NotResolved()",
  "error FinalityNotAccepted()",
  "error InvalidPricePending()",
  "error ZeroAmount()",
  "error ZeroReceiver()",
]);
