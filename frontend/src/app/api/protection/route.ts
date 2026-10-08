import { PublicError } from "@/lib/public-error";
import { randomUUID } from "node:crypto";
import type { Address } from "viem";
import { engineAbi } from "@/abi/engine";
import { client } from "@/lib/public-client";
import { validateRule } from "@/lib/protection";
import { apiError, authenticate, configured, jsonBody, ownedWallet, signingWallet } from "@/server/privy";
import { delegatedEngines } from "@/server/policy";
import { db } from "@/server/store";
import { canonicalRead, ensureDeployment } from "@/lib/deployment-check";
import { marketByEngine } from "@/config/deployment";
import { insertProtectionRule } from "@/server/protection-rule-store";
export const runtime = "nodejs";
export async function GET(request: Request) {
  if (!configured("protect")) return Response.json({ configured: false, rules: [], journal: [], workerOnline: false });
  try {
    const user = await authenticate(request), address = new URL(request.url).searchParams.get("wallet") ?? "";
    await ownedWallet(user, address);
    const rules = db().prepare("SELECT id,engine,body,status,message,hash,created FROM rules WHERE user=? AND wallet=? ORDER BY created DESC LIMIT 100").all(user, address.toLowerCase());
    const journal = db().prepare("SELECT j.* FROM journal j JOIN rules r ON r.id=j.rule_id WHERE r.user=? AND r.wallet=? ORDER BY j.id DESC LIMIT 100").all(user, address.toLowerCase());
    const beat = db().prepare("SELECT value FROM service WHERE id='heartbeat'").get() as { value: number } | undefined;
    return Response.json({ configured: true, rules, journal, workerOnline: !!beat && beat.value > Date.now() - 30000, claimDelivery: !!process.env.CLAIM_DELIVERY_PRIVATE_KEY }, { headers: { "cache-control": "no-store" } });
  } catch (e) { return apiError(e); }
}
export async function POST(request: Request) {
  if (!configured("protect")) return Response.json({ error: "Background protection is not configured." }, { status: 503 });
  try {
    const user = await authenticate(request), body = await jsonBody(request);
    if (body.action === "cancel" && typeof body.id === "string") {
      db().prepare("UPDATE rules SET status='cancelled',message='Cancelled by owner' WHERE id=? AND user=? AND status='active'").run(body.id, user);
      return Response.json({ ok: true });
    }
    if (body.action !== "create" || typeof body.wallet !== "string" || typeof body.engine !== "string" || !delegatedEngines.includes(body.engine.toLowerCase())) throw new PublicError("Invalid protection request.");
    if (!marketByEngine(body.engine)) throw new PublicError("This market is not in the verified deployment.");
    const rule = validateRule(body.rule, Math.floor(Date.now() / 1000));
    if (rule.kind === "claim_delivery") {
      if (!process.env.CLAIM_DELIVERY_PRIVATE_KEY) throw new PublicError("Claim delivery service is not configured.");
      await ownedWallet(user, body.wallet);
    } else await signingWallet(user, body.wallet, "protect");
    await ensureDeployment(body.engine);
    const head = await client.getBlock({ blockTag: "finalized" });
    if (Math.abs(Date.now() - Number(head.timestamp) * 1000) > 30000) throw new PublicError("Market state is stale. Refresh and try again.");
    const position = await canonicalRead(head.number, async () => {
      const id = await client.readContract({ address: body.engine as Address, abi: engineAbi, functionName: "participantId", args: [body.wallet as Address], blockNumber: head.number });
      if (!id) throw new PublicError("Fund this wallet's market account first.");
      return client.readContract({ address: body.engine as Address, abi: engineAbi, functionName: "previewAccount", args: [id], blockNumber: head.number });
    });
    if (!["auto_cancel", "claim_delivery"].includes(rule.kind) && (!position.positionLots || (position.positionLots > 0n) !== rule.long || BigInt(rule.maxLots) > (position.positionLots < 0n ? -position.positionLots : position.positionLots))) throw new PublicError("Rule direction or size does not match the current position.");
    const ruleId = randomUUID();
    insertProtectionRule({ id: ruleId, user, wallet: body.wallet, engine: body.engine, body: JSON.stringify(rule), created: Date.now() });
    return Response.json({ id: ruleId });
  } catch (e) { return apiError(e); }
}
