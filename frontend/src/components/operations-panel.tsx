"use client";
import { useQuery } from "@tanstack/react-query";
import type { Address } from "viem";
import { engineAbi } from "@/abi/engine";
import { client, type MarketSnapshot } from "@/lib/reads";
import { canonicalRead } from "@/lib/deployment-check";
import { useTx } from "@/lib/tx";
import { lotsToClaims, qToMoney } from "@/lib/units";
import { useOwner } from "./wallet";
import { Button, Row } from "./ui";
import { TxFeedback } from "./tx-feedback";
import { isContractRevert } from "@/lib/read-errors";

export function OperationsPanel({ engine, m }: { engine: Address; m: MarketSnapshot }) {
  const owner = useOwner(), tx = useTx();
  const busy = tx.state.status === "pending" || tx.state.status === "sent";
  const s = m.settlement;
  const actions = [
    { name: "beginRollover", label: "Start epoch rollover", args: [], due: m.active && !m.halted && m.risk.accountingState === 0 && m.risk.asOfTime >= m.epoch.end },
    { name: "rollPage", label: "Process rollover (32)", args: [32], due: m.risk.accountingState === 1 },
    { name: "finishRollover", label: "Finish epoch rollover", args: [], due: m.risk.accountingState === 1 },
    { name: "samplePerp", label: "Sample book price", args: [], due: m.active && !m.halted && m.risk.indexAvailable },
    { name: "floorSweep", label: "Process backing floor (32)", args: [32n], due: !!(m.risk.pendingWork & 1) },
    { name: "materializeScheduledHalt", label: "Record scheduled halt", args: [], due: !m.halted && m.risk.asOfTime >= m.listing.scheduledT },
    { name: "captureInvalidPrice", label: "Capture INVALID price", args: [], due: s.oracleFinalityAccepted && s.finalOutcome === 3 && !s.invalidPriceReady },
    { name: "prepareSnapshotChunk", label: "Prepare snapshot (32)", args: [32n], due: m.halted && !s.accountingComplete && !s.claimsEnabled },
    { name: "preparePayoutChunk", label: "Prepare payouts (32)", args: [32n], due: s.oracleFinalityAccepted && !s.claimsEnabled && !s.recoveryRequired },
    { name: "finishPreparation", label: "Open claims", args: [], due: s.oracleFinalityAccepted && s.accountingComplete && !s.claimsEnabled && !s.recoveryRequired },
  ];
  const q = useQuery({ queryKey: ["operations", engine, m.block.toString(), owner.address], queryFn: async () => canonicalRead(m.block, async () => {
    const available = await Promise.all(actions.map(async (a) => { if (!a.due) return false; try { const simulation = await client.simulateContract({ address: engine, abi: engineAbi, functionName: a.name, args: a.args, account: owner.address, blockNumber: m.block } as never); return a.name === "samplePerp" || (simulation.result as unknown) !== false; } catch (error) { if (isContractRevert(error)) return false; throw error; } }));
    const earnings = owner.address ? await client.readContract({ address: engine, abi: engineAbi, functionName: "keeperQ", args: [owner.address], blockNumber: m.block }) : 0n;
    return { available, earnings };
  })});
  const candidates = useQuery({ queryKey: ["liquidation-candidates", engine, m.block.toString()], enabled: m.listing.deploymentCapX > 1n && !m.halted && m.participants <= 1024n, queryFn: async () => canonicalRead(m.block, async () => {
    const people = await client.multicall({ blockNumber: m.block, allowFailure: false, contracts: Array.from({ length: Number(m.participants) }, (_, i) => ({ address: engine, abi: engineAbi, functionName: "traderIdAt", args: [BigInt(i)] } as const)) });
    const values = await client.multicall({ blockNumber: m.block, allowFailure: false, contracts: people.map(([id]) => ({ address: engine, abi: engineAbi, functionName: "accountRiskView", args: [id] } as const)) });
    return values.filter((v) => v.liquidationMode !== 0);
  })});
  const ready = !!owner.address && !owner.wrongChain && !busy;
  return <section className="p-4" aria-label="Permissionless operations">
    <h3 className="text-base font-semibold">Market upkeep</h3><p className="mt-2 max-w-2xl text-sm text-fg-3">Anyone can advance due accounting and settlement work. Each action processes a bounded page, is simulated first, and requires your wallet&apos;s gas.</p>
    <dl className="my-4 max-w-xl"><Row k="Snapshot progress" v={`${s.snapshotCursor} / ${s.accountCount}`} /><Row k="Payout progress (scan + allocation)" v={`${s.payoutCursor} / ${2n * s.accountCount}`} /><Row k="Keeper earnings" v={q.data ? qToMoney(q.data.earnings).usdc : "…"} /></dl>
    {q.isError ? <p className="text-sm text-ask">Operation checks failed. <button className="underline" onClick={() => q.refetch()}>Retry</button></p> : <div className="flex flex-wrap gap-2">{actions.map((a, i) => q.data?.available[i] && <Button disabled={!ready} key={a.name} onClick={() => owner.address && tx.run(owner.address, [{ address: engine, abi: engineAbi, functionName: a.name, args: a.args, label: a.label }])}>{a.label}</Button>)}{q.data?.available.every((v) => !v) && <p className="text-sm text-fg-3">No executable upkeep action at this block.</p>}
      {!!q.data?.earnings && <Button disabled={!ready} onClick={() => owner.address && tx.run(owner.address, [{ address: engine, abi: engineAbi, functionName: "withdrawKeeper", args: [], label: "release keeper earnings to vault" }])}>Collect keeper earnings</Button>}
    </div>}
    {candidates.isError && <p className="mt-3 text-sm text-ask">Liquidation candidate reads failed.</p>}
    {!!candidates.data?.length && <div className="mt-6"><h3 className="mb-2 text-base">Liquidation candidates</h3>{candidates.data.map((v) => {
      const partner = candidates.data.find((p) => p.trader !== v.trader && p.positionLots * v.positionLots < 0n)?.trader ?? 0;
      const size = v.positionLots < 0n ? -v.positionLots : v.positionLots;
      return <div key={v.trader} className="hair-b flex flex-wrap items-center justify-between gap-3 py-2 text-sm"><span>Account {v.trader} · {lotsToClaims(v.positionLots)} claims · mode {v.liquidationMode}</span><Button disabled={!ready} onClick={() => owner.address && tx.run(owner.address, [{ address: engine, abi: engineAbi, functionName: "liquidate", args: [v.trader, size, m.maxFills, partner], label: `liquidate account ${v.trader}` }])}>Process liquidation</Button></div>;
    })}</div>}
    <TxFeedback state={tx.state} />
  </section>;
}
