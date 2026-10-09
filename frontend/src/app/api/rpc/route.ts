import { isSameOriginRpcRequest, parseRpcRequests, sanitizeRpcResponse, readRpcBody, RpcBodyError } from "@/lib/rpc-proxy";
import { pooledReadTransport } from "@/lib/read-rpc-transport";
import type { EIP1193RequestFn } from "viem";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
let inFlight = 0;
const headers = { "Cache-Control": "no-store" };
let configured: { key: string; request: EIP1193RequestFn } | undefined;
function upstreamRequest() {
  const primary = process.env.MONAD_RPC_URL || "https://testnet-rpc.monad.xyz";
  const fallbacks = process.env.MONAD_FRONTEND_READ_FALLBACK_URLS ?? process.env.MONAD_READ_FALLBACK_URLS ?? "";
  const capacities = process.env.MONAD_FRONTEND_READ_RPC_CAPACITIES ?? process.env.MONAD_READ_RPC_CAPACITIES ?? "";
  const key = JSON.stringify([primary, fallbacks, capacities]);
  if (!configured || configured.key !== key) configured = { key, request: pooledReadTransport(primary, fallbacks, capacities)({}).request };
  return configured.request;
}

export async function POST(request: Request) {
  if (!isSameOriginRpcRequest(request)) return Response.json({ error: "Origin not allowed" }, { status: 403, headers });
  if (inFlight >= 6) return Response.json({ error: "RPC busy; retry shortly" }, { status: 429, headers: { ...headers, "Retry-After": "1" } });
  let send: EIP1193RequestFn;
  try { send = upstreamRequest(); }
  catch { return Response.json({ error: "RPC configuration unavailable" }, { status: 503, headers }); }
  inFlight++;
  try {
    let body: unknown, requests: ReturnType<typeof parseRpcRequests>;
    try { body = await readRpcBody(request); requests = parseRpcRequests(body); }
    catch (error) { return Response.json({ error: error instanceof RpcBodyError ? error.message : "Invalid or unsupported read request" }, { status: error instanceof RpcBodyError ? error.status : 400, headers }); }
    const rows = await Promise.all(requests.map(async r => {
      try { return { jsonrpc: "2.0", id: r.id, result: await send({ method: r.method, params: r.params } as Parameters<EIP1193RequestFn>[0]) }; }
      catch (error) {
        // Keep ABI revert bytes while dropping URLs, provider messages and metadata.
        let e = error as { code?: number; data?: unknown; cause?: unknown }, found = e;
        for (let i = 0; e && i < 8; i++, e = e.cause as typeof e) if (typeof e.code === "number") found = e;
        return { jsonrpc: "2.0", id: r.id, error: { code: found.code ?? -32603, data: found.data } };
      }
    }));
    return Response.json(sanitizeRpcResponse(rows, requests, Array.isArray(body)), { headers });
  } catch { return Response.json({ error: "RPC temporarily unavailable" }, { status: 502, headers }); }
  finally { inFlight--; }
}
