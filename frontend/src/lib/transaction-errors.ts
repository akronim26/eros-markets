import { BaseError, ContractFunctionRevertedError, decodeErrorResult, parseAbi } from "viem";

export type TransactionErrorContext = { functionName?: string };

// Verified against RiskStorage.sol and vaults/CollateralVault.sol. A vault call can
// bubble an engine error that is absent from the ABI used to simulate that call.
// Keep this list small rather than importing the complete engine ABI into errors.
const errorAbi = parseAbi([
  "error BadState()",
  "error Unauthorized()",
  "error BadUnits()",
  "error Coverage()",
  "error Rejected()",
  "error Stale()",
  "error TransferFailed()",
  "error Reentrant()",
]);

function knownMessage(name: string, context?: TransactionErrorContext): string | undefined {
  switch (name) {
    case "BadState":
      return context?.functionName === "allocate"
        ? "This market cannot accept collateral in its current state. Accounting maintenance may be required. Refresh the market status before retrying."
        : "The market cannot process this action in its current state. Accounting maintenance may be required. Refresh the market status before retrying.";
    case "Unauthorized":
      return "The contract does not currently allow this action. Check your selected wallet and the market status.";
    case "BadUnits":
      return "The contract rejected the amount or input values. Check them before retrying.";
    case "Coverage":
      return "The market does not have enough reserve coverage for this action. Refresh the market status and review the amount.";
    case "Rejected":
      return "The contract's risk checks did not approve this action. Refresh your balances and review the amount.";
    case "Stale":
      return "The market state changed or is no longer current. Refresh and review the action again.";
    case "TransferFailed":
      return "The collateral transfer failed. Check your token balance and spending approval before retrying.";
    case "Reentrant":
      return "The contract's transaction safety check blocked this action. Refresh before retrying.";
  }
}

/** Explain verified contract errors; preserve existing wallet, RPC and unknown-error messages. */
export function revertMessage(e: unknown, context?: TransactionErrorContext): string {
  if (e instanceof BaseError) {
    const reverted = e.walk((cause) => cause instanceof ContractFunctionRevertedError);
    if (reverted instanceof ContractFunctionRevertedError) {
      if (reverted.raw && reverted.raw !== "0x") {
        try {
          const decoded = decodeErrorResult({ abi: errorAbi, data: reverted.raw });
          const message = knownMessage(decoded.errorName, context);
          if (message) return message;
        } catch {
          // Unknown or malformed data stays with viem's original explanation.
          // Never infer a contract error from a hex string inside message text.
        }
      }
      return reverted.data?.errorName ? `Reverted: ${reverted.data.errorName}` : reverted.shortMessage;
    }
    return e.shortMessage;
  }
  return e instanceof Error ? e.message : String(e);
}
