"use client";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { formatUnits, hexToString, parseAbi, zeroAddress, zeroHash, type Address, type Hex } from "viem";
import { resolutionOracleAbi } from "@/abi/resolutionOracle";
import { umaAdapterAbi } from "@/abi/umaAdapter";
import { deployment } from "@/config/deployment";
import { client, erc20Abi, useOracleMarket } from "@/lib/reads";
import { canDispute, ORACLE_ACTIONS, validEvidence } from "@/lib/oracle-actions";
import { fmtDuration } from "@/lib/units";
import { canonicalRead } from "@/lib/deployment-check";
import { useTx } from "@/lib/tx";
import { useOwner } from "./wallet";
import { Button, Row } from "./ui";
import { FieldError, useFieldErrors, PendingState } from "./feedback";
import { TxFeedback } from "./tx-feedback";
import { isContractRevert } from "@/lib/read-errors";

const tokenMeta = parseAbi(["function decimals() view returns (uint8)", "function symbol() view returns (string)"]);
const ooAbi = parseAbi(["function disputeAssertion(bytes32 assertionId, address disputer)", "function getAssertion(bytes32) view returns (((bool arbitrateViaEscalationManager,bool discardOracle,bool validateDisputers,address assertingCaller,address escalationManager) escalationManagerSettings,address asserter,uint64 assertionTime,bool settled,address currency,uint64 expirationTime,bool settlementResolution,bytes32 domainId,bytes32 identifier,uint256 bond,address callbackRecipient,address disputer))"]);
type Data = NonNullable<ReturnType<typeof useOracleMarket>["data"]>;

export function OracleActions({ data: d }: { data: Data }) {
  const owner = useOwner(), tx = useTx();
  const [outcome, setOutcome] = useState(1), [uri, setUri] = useState(""), [hash, setHash] = useState("");
  const [accepted, setAccepted] = useState(false);
  const uriValid = /^(https:\/\/|ipfs:\/\/)/.test(uri) && new TextEncoder().encode(uri).length <= 256;
  const hashValid = /^0x[0-9a-fA-F]{64}$/.test(hash) && !/^0x0+$/.test(hash);
  const validation = useFieldErrors({ uri: uriValid ? "" : "Use an HTTPS or IPFS evidence URL, up to 256 bytes.", hash: hashValid ? "" : "Enter a nonzero 32-byte content hash (0x followed by 64 hex characters)." });
  const r = d.resolution;
  const busy = tx.state.status === "pending" || tx.state.status === "sent";
  const info = useQuery({ queryKey: ["oracle-actions", d.id, d.block.toString(), owner.address], queryFn: async () => canonicalRead(d.block, async () => {
    const oracle = { address: deployment.oracle.resolutionOracle, abi: resolutionOracleAbi, blockNumber: d.block } as const;
    const trust = r.trustSetId ? await client.readContract({ ...oracle, functionName: "trustSet", args: [r.trustSetId] }) : undefined;
    const venue = r.assertionVenue !== zeroAddress ? r.assertionVenue : trust?.cfg.venue;
    const allowed = await Promise.all(ORACLE_ACTIONS.map(async ([name]) => {
      try {
        const simulation = await client.simulateContract({ ...oracle, functionName: name, args: [d.id], account: owner.address ?? zeroAddress });
        return simulation.result === true || (name === "finalizeMarket" && Number(simulation.result) > 0);
      } catch (error) { if (isContractRevert(error)) return false; throw error; }
    }));
    if (!venue) return { allowed, bond: undefined };
    const [token, oo, assertion] = await Promise.all([
      client.readContract({ address: venue, abi: umaAdapterAbi, functionName: "bondCurrency", blockNumber: d.block }),
      client.readContract({ address: venue, abi: umaAdapterAbi, functionName: "oov3", blockNumber: d.block }),
      r.assertionId !== zeroHash ? client.readContract({ address: venue, abi: umaAdapterAbi, functionName: "statusOf", args: [r.assertionId], blockNumber: d.block }) : undefined,
    ]);
    const actual = assertion?.exists ? await client.readContract({ address: oo, abi: ooAbi, functionName: "getAssertion", args: [r.assertionId], blockNumber: d.block }) : undefined;
    if (actual && (actual.currency.toLowerCase() !== token.toLowerCase() || actual.callbackRecipient.toLowerCase() !== venue.toLowerCase())) throw new Error("Assertion venue mismatch");
    const [decimals, symbol, balance] = await client.multicall({ blockNumber: d.block, allowFailure: false, contracts: [
      { address: token, abi: tokenMeta, functionName: "decimals" }, { address: token, abi: tokenMeta, functionName: "symbol" },
      { address: token, abi: erc20Abi, functionName: "balanceOf", args: [owner.address ?? zeroAddress] },
    ] });
    return { allowed, bond: { venue, token, oo, assertion, decimals, symbol, balance, amount: actual?.bond ?? d.bond } };
  })});
  const bond = info.data?.bond;
  const dispute = bond?.assertion && canDispute(bond.assertion, d.now);
  const propose = r.state === 6 && r.attempts < 3;
  const ready = !!owner.address && !owner.wrongChain && !busy && !info.isError;
  async function bonded(action: "propose" | "dispute") {
    if (!ready || !bond || !accepted || !owner.address) return;
    const amount = action === "propose" ? d.bond : bond.amount;
    const spender = action === "propose" ? bond.venue : bond.oo;
    await tx.run(owner.address, [
      { address: bond.token, abi: erc20Abi, functionName: "approve", args: [spender, amount], label: "approve exact bond" },
      action === "propose" ? { address: deployment.oracle.resolutionOracle, abi: resolutionOracleAbi, functionName: "proposePermissionless", args: [d.id, outcome, uri, hash as Hex], label: "propose outcome" }
        : { address: bond.oo, abi: ooAbi, functionName: "disputeAssertion", args: [r.assertionId, owner.address], label: "dispute assertion" },
    ]);
    setAccepted(false);
  }
  return <div className="col-span-full border-t border-line pt-4">
    {d.claim !== "0x" && <details className="mb-4"><summary className="label cursor-pointer text-fg-2">Exact assertion claim</summary><p className="mt-2 whitespace-pre-wrap break-words text-xs text-fg-3">{hexToString(d.claim)}</p></details>}
    {info.isPending && <PendingState>Checking available oracle actions…</PendingState>}
    {info.isError && <p role="alert" className="text-sm text-ask">Action checks unavailable. <button className="underline" onClick={() => info.refetch()}>Retry</button></p>}
    {(propose || dispute) && bond && <div className="mb-4 grid max-w-xl gap-3 border border-line-strong p-4">
      <h3 className="text-base font-semibold">{propose ? "Propose an outcome" : "Challenge this outcome"}</h3>
      <dl><Row k="Bond at risk" v={`${formatUnits(propose ? d.bond : bond.amount, bond.decimals)} ${bond.symbol}`} /><Row k="Challenge window" v={fmtDuration(dispute ? bond.assertion!.expiresAt - d.now : d.liveness)} /></dl>
      {propose && <>
        <label className="label">Outcome<select className="mt-1 h-10 w-full border border-line-strong bg-ground px-2" value={outcome} onChange={(e) => setOutcome(Number(e.target.value))}>{["YES", "NO", "INVALID"].map((x, i) => <option key={x} value={i + 1} disabled={!!(r.rejectedMask & (1 << (i + 1)))}>{x}{r.rejectedMask & (1 << (i + 1)) ? " (rejected)" : ""}</option>)}</select></label>
        <label className="label">Evidence URL<input className="mt-1 h-10 w-full border border-line-strong bg-ground px-2 normal-case" placeholder="https://… or ipfs://…" value={uri} {...validation.props("uri")} onChange={(e) => setUri(e.target.value)} /><FieldError id={validation.errorId("uri")}>{validation.message("uri")}</FieldError></label>
        <label className="label">Evidence content hash<input className="mt-1 h-10 w-full border border-line-strong bg-ground px-2 normal-case" placeholder="0x… (32 bytes)" value={hash} {...validation.props("hash")} onChange={(e) => setHash(e.target.value)} /><FieldError id={validation.errorId("hash")}>{validation.message("hash")}</FieldError></label>
      </>}
      <label className="flex items-start gap-2 text-xs text-fg-2"><input type="checkbox" className="mt-0.5" checked={accepted} onChange={(e) => setAccepted(e.target.checked)} />I understand this bond can be lost if the decision goes against me.</label>
      <Button variant="primary" size="lg" disabled={!ready || !accepted || bond.balance < (propose ? d.bond : bond.amount) || (propose && (!validEvidence(uri, hash) || !!(r.rejectedMask & (1 << outcome))))} onClick={() => bonded(propose ? "propose" : "dispute")}>{!owner.address ? "Log in to continue" : owner.wrongChain ? "Switch to Monad testnet" : bond.balance < (propose ? d.bond : bond.amount) ? "Insufficient bond tokens" : propose ? "Post proposal and bond" : "Dispute and post bond"}</Button>
    </div>}
    <div className="flex flex-wrap gap-2">{ORACLE_ACTIONS.map(([name, label], i) => info.data?.allowed[i] && <Button key={name} disabled={!ready} onClick={() => owner.address && tx.run(owner.address, [{ address: deployment.oracle.resolutionOracle, abi: resolutionOracleAbi, functionName: name, args: [d.id], label }])}>{label}</Button>)}</div>
    <TxFeedback state={tx.state} />
  </div>;
}
