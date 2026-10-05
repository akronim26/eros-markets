import { BaseError, ContractFunctionRevertedError, ContractFunctionZeroDataError } from "viem";

/** A contract rejecting an action is different from a node failing to answer. */
export function isContractRevert(error: unknown) {
  return error instanceof BaseError && error.walk((cause) => cause instanceof ContractFunctionRevertedError) instanceof ContractFunctionRevertedError;
}

export function isMissingContract(error: unknown) {
  return error instanceof BaseError && error.walk((cause) => cause instanceof ContractFunctionZeroDataError) instanceof ContractFunctionZeroDataError;
}
