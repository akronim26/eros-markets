/** Read-only JSON-RPC boundary. The upstream URL must remain server-side. */
export { isSameOriginRequest as isSameOriginRpcRequest } from "./request-origin";
export class RpcBodyError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

/** Bound the entire upload, including clients that never finish a small body. */
export async function readRpcBody(request: Request, { maxBytes = 256_000, timeoutMs = 5000 } = {}): Promise<unknown> {
  if (Number(request.headers.get("content-length") || 0) > maxBytes) throw new RpcBodyError("Request too large", 413);
  const reader = request.body?.getReader();
  if (!reader) throw new RpcBodyError("Missing request body", 400);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new RpcBodyError("Request body timed out", 408)), timeoutMs);
  });
  try {
    const chunks: Uint8Array[] = []; let size = 0;
    while (true) {
      const { value, done } = await Promise.race([reader.read(), expired]);
      if (done) break;
      size += value.length;
      if (size > maxBytes) throw new RpcBodyError("Request too large", 413);
      chunks.push(value);
    }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    try { return JSON.parse(new TextDecoder().decode(bytes)); }
    catch { throw new RpcBodyError("Invalid request body", 400); }
  } finally {
    clearTimeout(timer);
    // Cancellation must not hold an RPC slot if the stream's producer stalls too.
    void reader.cancel().catch(() => {});
  }
}

const methods = new Set([
  "eth_chainId", "eth_blockNumber", "eth_getBlockByNumber", "eth_getBlockByHash",
  "eth_getCode", "eth_call", "eth_getLogs", "eth_getBalance",
  "eth_getTransactionReceipt", "eth_getTransactionByHash", "eth_getTransactionCount",
  "eth_estimateGas", "eth_gasPrice", "eth_maxPriorityFeePerGas", "eth_feeHistory",
]);
type RpcRequest = { jsonrpc: "2.0"; id: number | string; method: string; params: unknown[] };
export function parseRpcRequests(body: unknown): RpcRequest[] {
  const batch = Array.isArray(body) ? body : [body];
  if (!batch.length || batch.length > 32) throw new Error("Invalid RPC batch");
  return batch.map((value) => {
    if (!value || typeof value !== "object") throw new Error("Invalid RPC request");
    const r = value as Record<string, unknown>;
    if (r.jsonrpc !== "2.0" || (typeof r.id !== "string" && !(typeof r.id === "number" && Number.isSafeInteger(r.id)))
      || typeof r.method !== "string" || !methods.has(r.method) || (r.params !== undefined && !Array.isArray(r.params))) throw new Error("Unsupported RPC request");
    return { jsonrpc: "2.0", id: r.id as number | string, method: r.method, params: (r.params ?? []) as unknown[] };
  });
}

export function sanitizeRpcResponse(value: unknown, requests: RpcRequest[], batch: boolean): unknown {
  const rows = Array.isArray(value) ? value : [value];
  if (rows.length !== requests.length) throw new Error("Incomplete RPC response");
  const seen = new Set<number | string>();
  const cleaned = rows.map((value) => {
    if (!value || typeof value !== "object") throw new Error("Invalid RPC response");
    const r = value as Record<string, unknown>;
    const request = requests.find((q) => q.id === r.id);
    if (!request || seen.has(request.id) || r.jsonrpc !== "2.0") throw new Error("Mismatched RPC response");
    seen.add(request.id);
    if (r.error) {
      const error = r.error as Record<string, unknown>;
      return { jsonrpc: "2.0", id: r.id, error: {
        code: typeof error.code === "number" ? error.code : -32603,
        message: "Upstream RPC request failed",
        ...(typeof error.data === "string" && /^0x[\da-fA-F]*$/.test(error.data) ? { data: error.data } : {}),
      } };
    }
    if (!("result" in r)) throw new Error("Missing RPC result");
    return { jsonrpc: "2.0", id: r.id, result: r.result };
  });
  return batch ? cleaned : cleaned[0];
}
