import { isSameOriginRpcRequest, parseRpcRequests, sanitizeRpcResponse, readRpcBody, RpcBodyError } from "@/lib/rpc-proxy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
let inFlight = 0;
const headers = { "Cache-Control": "no-store" };

export async function POST(request: Request) {
  if (!isSameOriginRpcRequest(request)) return Response.json({ error: "Origin not allowed" }, { status: 403, headers });
  if (inFlight >= 6) return Response.json({ error: "RPC busy; retry shortly" }, { status: 429, headers: { ...headers, "Retry-After": "1" } });
  const upstream = process.env.MONAD_RPC_URL || "https://testnet-rpc.monad.xyz";
  try {
    const url = new URL(upstream);
    if (url.protocol !== "https:" || url.username || url.password || url.hash) throw new Error();
  } catch { return Response.json({ error: "RPC configuration unavailable" }, { status: 503, headers }); }
  inFlight++;
  try {
    let body: unknown, requests: ReturnType<typeof parseRpcRequests>;
    try { body = await readRpcBody(request); requests = parseRpcRequests(body); }
    catch (error) { return Response.json({ error: error instanceof RpcBodyError ? error.message : "Invalid or unsupported read request" }, { status: error instanceof RpcBodyError ? error.status : 400, headers }); }
    const response = await fetch(upstream, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(Array.isArray(body) ? requests : requests[0]),
      signal: AbortSignal.timeout(12_000), redirect: "error", cache: "no-store",
    });
    if (!response.ok) return Response.json({ error: "RPC temporarily unavailable" }, { status: response.status === 429 ? 429 : 502, headers });
    return Response.json(sanitizeRpcResponse(await response.json(), requests, Array.isArray(body)), { headers });
  } catch { return Response.json({ error: "RPC temporarily unavailable" }, { status: 502, headers }); }
  finally { inFlight--; }
}
