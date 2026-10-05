import { apiError, authenticate, checkedPolicy, configured, ownedWallet, signerConfig } from "@/server/privy";
import { delegatedEngines } from "@/server/policy";
import { db } from "@/server/store";
export const runtime = "nodejs";
export async function GET(request: Request) {
  const modes = ["trade", "protect"] as const;
  if (!modes.some(configured)) return Response.json({ configured: false, modes: [] });
  try {
    const user = await authenticate(request), address = new URL(request.url).searchParams.get("wallet") ?? "";
    const wallet = await ownedWallet(user, address);
    const permissions = await Promise.all(modes.filter(configured).map(async (mode) => {
      const config = await checkedPolicy(mode);
      const granted = wallet.additional_signers.some((s) => s.signer_id === config.signer && s.override_policy_ids?.length === 1 && s.override_policy_ids[0] === config.policy);
      if (granted) db().prepare("INSERT OR IGNORE INTO grants VALUES (?,?,?)").run(wallet.id, config.signer!, Date.now());
      else db().prepare("DELETE FROM grants WHERE wallet=? AND signer=?").run(wallet.id, config.signer!);
      const observed = db().prepare("SELECT granted FROM grants WHERE wallet=? AND signer=?").get(wallet.id, config.signer!) as { granted: number } | undefined;
      return { mode, signer: config.signer, policy: config.policy, granted, observedAt: observed?.granted, engines: delegatedEngines };
    }));
    return Response.json({ configured: true, modes: permissions, workerOnline: Number((db().prepare("SELECT value FROM service WHERE id='heartbeat'").get() as { value: number } | undefined)?.value ?? 0) > Date.now() - 30000 }, { headers: { "cache-control": "no-store" } });
  } catch (e) { return apiError(e); }
}
