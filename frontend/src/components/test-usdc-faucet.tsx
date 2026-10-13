"use client";
import { useQuery } from "@tanstack/react-query";
import { erc20Abi, type Address } from "viem";
import { deployment } from "@/config/deployment";
import { client } from "@/lib/public-client";
import { useTx } from "@/lib/tx";
import { atomsToUsdc } from "@/lib/units";
import { useOwner } from "./wallet";
import { TxFeedback } from "./tx-feedback";
import { Button } from "./ui";

const faucetAbi = [{ type: "function", name: "mint", stateMutability: "nonpayable", inputs: [{ name: "to", type: "address" }, { name: "amount", type: "uint256" }], outputs: [] }] as const;
// The token's per-call cap is 100,000; these stay well under it.
const AMOUNTS = [1_000n, 10_000n] as const;
const { collateralToken: token, collateralSymbol: symbol } = deployment.risk;

/** Mints free test collateral to the connected wallet: the only source of tUSDC on testnet. */
export function TestUsdcFaucet({ address, gasAtoms, close, reopen }: { address: Address; gasAtoms?: bigint; close: () => void; reopen: () => void }) {
  const owner = useOwner(), tx = useTx();
  const balance = useQuery({ queryKey: ["test-usdc-balance", address],
    queryFn: () => client.readContract({ address: token as Address, abi: erc20Abi, functionName: "balanceOf", args: [address] }), refetchInterval: 15000 });
  const busy = tx.state.status === "pending" || tx.state.status === "sent";
  const blocker = owner.address?.toLowerCase() !== address.toLowerCase() ? "Connect this wallet to receive test tokens."
    : owner.wrongChain ? "Switch to Monad testnet to receive test tokens."
    : gasAtoms === 0n ? "Get test MON first: minting needs gas." : undefined;
  async function mint(whole: bigint) {
    // The wallet's confirmation prompt cannot appear above an open modal dialog.
    close();
    try { await tx.run(address, [{ address: token as Address, abi: faucetAbi, functionName: "mint", args: [address, whole * 1_000_000n], label: `get ${whole.toLocaleString()} ${symbol}` }]); }
    finally { void balance.refetch(); reopen(); }
  }
  return <div className="mt-4 border-t border-line pt-4" aria-label={`${symbol} faucet`}>
    <div className="flex items-center justify-between gap-3">
      <span className="label text-fg-2">{symbol} faucet</span>
      <span className="tnum text-xs">Wallet: {balance.data !== undefined ? `${atomsToUsdc(balance.data)} ${symbol}` : balance.isPending ? "Reading…" : "unavailable"}</span>
    </div>
    <p className="mt-2 text-xs text-fg-3">Free test collateral with no monetary value. Fund a market from your wallet after minting.</p>
    <div className="mt-3 grid grid-cols-2 gap-2">
      {AMOUNTS.map((whole) => <Button key={whole} disabled={busy || !!blocker} onClick={() => mint(whole)}>Get {whole.toLocaleString()} {symbol}</Button>)}
    </div>
    {blocker && <p className="mt-2 text-xs text-fg-3">{blocker}</p>}
    <div className="mt-2"><TxFeedback state={tx.state} /></div>
  </div>;
}
