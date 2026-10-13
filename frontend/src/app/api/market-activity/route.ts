import { getCache } from "@vercel/functions";
import { markets } from "@/config/deployment";
import { isSameOriginRpcRequest } from "@/lib/rpc-proxy";
import { parseHeartbeat, readActivity, recordHeartbeat } from "@/lib/market-activity";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// The Runtime Cache is per region: heartbeats and supervisor polls must use the same one.
export const preferredRegion = "iad1";
const headers = { "Cache-Control": "no-store" };
const engines = markets.filter(m => !m.archived).map(m => m.engine);
const cache = () => getCache({ namespace: "eros" });

export async function POST(request: Request) {
  if (!isSameOriginRpcRequest(request)) return Response.json({ error: "Origin not allowed" }, { status: 403, headers });
  if (Number(request.headers.get("content-length") || 0) > 512) return Response.json({ error: "Request too large" }, { status: 413, headers });
  let engine: string | undefined;
  try { engine = parseHeartbeat(await request.json(), engines); } catch { engine = undefined; }
  if (!engine) return Response.json({ error: "Unknown market" }, { status: 400, headers });
  try { await recordHeartbeat(cache(), engine, Date.now()); }
  catch { return Response.json({ error: "Activity unavailable" }, { status: 503, headers }); }
  return new Response(null, { status: 204, headers });
}

/** Polled by the market supervisor; a failure makes it keep markets awake. */
export async function GET() {
  try { return Response.json(await readActivity(cache(), engines), { headers }); }
  catch { return Response.json({ error: "Activity unavailable" }, { status: 503, headers }); }
}
