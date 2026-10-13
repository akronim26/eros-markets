export function fundingPlan(amount: bigint, free: bigint, wallet: bigint, allowance: bigint) {
  if (amount <= 0n) throw new Error("Enter an amount greater than zero.");
  const deposit = amount > free ? amount - free : 0n;
  if (deposit > wallet) throw new Error("Insufficient wallet and free vault balance.");
  return { approve: deposit > allowance ? deposit : 0n, deposit, allocate: amount };
}

export function amountWithinBalance(amount: bigint, balance: bigint) {
  if (amount <= 0n) throw new Error("Enter an amount greater than zero.");
  if (amount > balance) throw new Error("Amount exceeds the available balance.");
  return amount;
}

export function atomsToInput(atoms: bigint) {
  return `${atoms / 1_000_000n}.${(atoms % 1_000_000n).toString().padStart(6, "0")}`;
}

export function canClaim(status: { halted: boolean; claimsEnabled: boolean; recoveryRequired: boolean } | undefined, amount: bigint, _traderClaimed: boolean) {
  // Reserve redemption can credit a second owner claim after the trader payout.
  return !!status?.halted && status.claimsEnabled && !status.recoveryRequired && amount > 0n;
}
