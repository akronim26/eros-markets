import type { Address } from "viem";

export type WalletSnapshot = {
  address?: Address;
  chainId?: number;
  connectorUid?: string;
  ready: boolean;
  version: number;
};

/** A sequence is permanently invalidated if its wallet, network or login session changes. */
export function createWalletGuard(read: () => WalletSnapshot, account: Address, chainId: number) {
  const initial = read();
  if (!initial.ready || !initial.connectorUid || initial.address?.toLowerCase() !== account.toLowerCase()) {
    throw new Error("Select a connected wallet before continuing.");
  }
  if (initial.chainId !== chainId) throw new Error("Switch your wallet to Monad testnet before continuing.");
  let changed = false;
  const observe = () => {
    const next = read();
    changed ||= !next.ready || next.address?.toLowerCase() !== initial.address?.toLowerCase()
      || next.connectorUid !== initial.connectorUid || next.chainId !== initial.chainId || next.version !== initial.version;
  };
  return {
    initial,
    observe,
    assertCurrent() {
      observe();
      if (changed) throw new Error("Wallet or network changed. Remaining steps were stopped. Review your balances before retrying.");
    },
  };
}

/** Recheck at asynchronous boundaries; never continue a multi-call flow with another signer. */
export async function runWalletCalls<Call, Prepared, Result>(calls: readonly Call[], steps: {
  assertCurrent: () => void;
  prepare: (call: Call) => Promise<Prepared>;
  send: (prepared: Prepared, call: Call) => Promise<Result>;
  confirm: (result: Result, call: Call, last: boolean) => Promise<void>;
}) {
  for (const [index, call] of calls.entries()) {
    steps.assertCurrent();
    const prepared = await steps.prepare(call);
    steps.assertCurrent();
    const result = await steps.send(prepared, call);
    // A submitted transaction must still be tracked, even when the user switches wallets.
    await steps.confirm(result, call, index === calls.length - 1);
    steps.assertCurrent();
  }
}
