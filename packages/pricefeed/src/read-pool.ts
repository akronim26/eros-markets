/** Dependency-free read routing. Credentials remain inside endpoint closures and never enter errors. */
export type PoolRequest = { method: string; params?: readonly unknown[] };
export type PoolEndpoint = { url: string; capacity: number };
type Block = { number: string; hash: string; timestamp: string };
type Anchor = { hash: string; endpoint: number; checked: Map<number, number> };
type Endpoint = PoolEndpoint & { inFlight: number; until: number; checkedAt: number; headTime: number;
  failures: number; probe?: Promise<void> | undefined };

const reads = new Set(['eth_chainId', 'eth_blockNumber', 'eth_getBlockByNumber', 'eth_getBlockByHash',
  'eth_getCode', 'eth_call', 'eth_getLogs', 'eth_getBalance', 'eth_getTransactionReceipt',
  'eth_getTransactionByHash', 'eth_gasPrice', 'eth_maxPriorityFeePerGas', 'eth_feeHistory']);

/** Pending state, simulation and nonce allocation must use the coordinated writer endpoint. */
export function writerLane(request: PoolRequest): boolean {
  return request.method === 'eth_getTransactionCount' || request.method === 'eth_estimateGas'
    || request.params?.some(value => value === 'pending') === true
    || request.method === 'eth_call' && !!(request.params?.[0] as { from?: unknown } | undefined)?.from;
}

export function readPoolEndpoints(primary: string, fallbacks = '', capacities = ''): PoolEndpoint[] {
  const urls = [...new Set([primary, ...fallbacks.split(',').map(v => v.trim()).filter(Boolean)])];
  if (urls.length > 8) throw new Error('RPC_POOL_TOO_MANY_ENDPOINTS');
  const limits = capacities ? capacities.split(',').map(Number) : urls.map(() => 8);
  if (limits.length !== urls.length || limits.some(n => !Number.isInteger(n) || n < 1 || n > 32))
    throw new Error('RPC_POOL_INVALID_CAPACITY');
  return urls.map((value, i) => {
    let url: URL; try { url = new URL(value); } catch { throw new Error('MONAD_BAD_RPC_URL'); }
    if (url.protocol !== 'https:' || url.username || url.password || url.hash) throw new Error('MONAD_HTTPS_RPC_REQUIRED');
    return { url: value, capacity: limits[i]! };
  });
}

function block(value: unknown): Block {
  const b = value as Block | undefined;
  if (!b || !/^0x[\da-f]+$/i.test(b.number) || !/^0x[\da-f]{64}$/i.test(b.hash)
    || !/^0x[\da-f]+$/i.test(b.timestamp)) throw new Error('RPC_POOL_INVALID_BLOCK');
  return b;
}

function errorValues(error: unknown): { code?: number; status?: number; data?: unknown; name?: string; message?: string }[] {
  const rows = []; let current = error;
  for (let i = 0; current && typeof current === 'object' && i < 8; i++) {
    rows.push(current as { code?: number; status?: number; data?: unknown; name?: string; message?: string });
    current = (current as { cause?: unknown }).cause;
  }
  return rows;
}

/** Never turn a deterministic contract revert into a retry on another view of the chain. */
function transient(error: unknown): boolean {
  const rows = errorValues(error);
  if (rows.some(e => e.code === 3 || typeof e.data === 'string' && /^0x[\da-f]{8,}$/i.test(e.data))) return false;
  return rows.some(e => e.status === 429 || (e.status ?? 0) >= 500
    || [-32005, -32016, -32601, -32603].includes(e.code ?? 0)
    || /rate.?limit|too many requests|quota|compute units|header not found|unknown block|block not found|missing trie/i.test(e.message ?? '')
    || ['HttpRequestError', 'TimeoutError', 'AbortError', 'SocketClosedError', 'WebSocketRequestError'].includes(e.name ?? ''));
}

function pinnedNumber(request: PoolRequest): string | undefined {
  const p = request.params ?? [];
  const tag = ['eth_call', 'eth_getCode', 'eth_getBalance'].includes(request.method) ? p[1]
    : request.method === 'eth_getBlockByNumber' ? p[0] : undefined;
  return typeof tag === 'string' && /^0x[\da-f]+$/i.test(tag) ? `0x${BigInt(tag).toString(16)}` : undefined;
}

export function createReadPool(options: {
  endpoints: PoolEndpoint[]; chainId: number;
  request: (url: string, request: PoolRequest) => Promise<unknown>;
  now?: () => number; healthTtlMs?: number; maxHeadAgeMs?: number;
}) {
  const now = options.now ?? Date.now, ttl = options.healthTtlMs ?? 15_000;
  const states: Endpoint[] = options.endpoints.map(e => ({ ...e, inFlight: 0, until: 0,
    checkedAt: -Infinity, headTime: 0, failures: 0 }));
  if (!states.length) throw new Error('RPC_POOL_EMPTY');
  const anchors = new Map<string, Anchor>(), pending = new Map<string, Promise<unknown>>();
  const waiting = new Set<() => void>();
  let rotation = 0;
  // A receipt can establish finality through one provider before the next
  // lifecycle snapshot reaches another. Returning an older finalized block
  // would falsely turn provider lag into a persisted source-history regression.
  let finalized: Block | undefined;
  const quarantine = (e: Endpoint) => {
    e.failures++; e.until = now() + Math.min(30_000, 1000 * 2 ** Math.min(e.failures, 5));
    e.checkedAt = -Infinity;
  };
  const probe = async (e: Endpoint) => {
    if (now() < e.until) throw new Error('RPC_POOL_ENDPOINT_COOLING');
    if (now() - e.checkedAt < ttl && now() - e.headTime <= (options.maxHeadAgeMs ?? 30_000)) return;
    if (!e.probe) e.probe = (async () => {
      const [chain, raw] = await Promise.all([
        options.request(e.url, { method: 'eth_chainId' }),
        options.request(e.url, { method: 'eth_getBlockByNumber', params: ['finalized', false] }),
      ]);
      if (chain !== `0x${options.chainId.toString(16)}`) throw new Error('RPC_POOL_WRONG_CHAIN');
      const head = block(raw), headTime = Number(BigInt(head.timestamp)) * 1000;
      if (headTime > now() + 1000 || now() - headTime > (options.maxHeadAgeMs ?? 30_000)) throw new Error('RPC_POOL_STALE_HEAD');
      // Finalized and explicit-height queries are required, with identical hashes.
      const canonical = block(await options.request(e.url, { method: 'eth_getBlockByNumber', params: [head.number, false] }));
      if (canonical.hash !== head.hash) throw new Error('RPC_POOL_NONCANONICAL_HEAD');
      e.headTime = headTime; e.checkedAt = now();
    })().catch(error => { quarantine(e); throw error; }).finally(() => { e.probe = undefined; });
    return e.probe;
  };
  const remember = (b: Block, endpoint: number) => {
    const key = `0x${BigInt(b.number).toString(16)}`;
    const previous = anchors.get(key);
    if (previous && previous.hash !== b.hash) throw new Error('RPC_POOL_BLOCK_CHANGED');
    const anchor = previous ?? { hash: b.hash, endpoint, checked: new Map<number, number>() };
    anchor.checked.set(endpoint, now()); anchors.set(key, anchor);
    if (anchors.size > 256) anchors.delete(anchors.keys().next().value!);
  };
  async function run(request: PoolRequest, deadline = now() + 5000): Promise<unknown> {
    if (!reads.has(request.method) || writerLane(request)) throw new Error('RPC_POOL_READ_ONLY');
    const pin = pinnedNumber(request), anchor = pin ? anchors.get(pin) : undefined;
    const offset = rotation++ % states.length;
    const indices = states.map((_, i) => (i + offset) % states.length).sort((a, b) => {
      const left = states[a]!, right = states[b]!;
      if ((now() < left.until) !== (now() < right.until)) return now() < left.until ? 1 : -1;
      if (anchor && left.inFlight < left.capacity && right.inFlight < right.capacity) {
        if (a === anchor.endpoint) return -1;
        if (b === anchor.endpoint) return 1;
      }
      return left.inFlight / left.capacity - right.inFlight / right.capacity;
    });
    for (const i of indices) {
      if (now() >= deadline) break;
      const e = states[i]!;
      if (now() < e.until || e.inFlight >= e.capacity) continue;
      e.inFlight++;
      let probing = true;
      try {
        await probe(e);
        const freshest = Math.max(...states.filter(s => now() - s.checkedAt < ttl).map(s => s.headTime));
        if (freshest - e.headTime > 10_000) {
          // A cached health timestamp alone is not evidence of provider lag.
          e.checkedAt = -Infinity; await probe(e);
          if (freshest - e.headTime > 10_000) { quarantine(e); continue; }
        }
        probing = false;
        // Affinity keeps a snapshot together; failover must prove its original block hash.
        if (pin && anchor && (now() - (anchor.checked.get(i) ?? -Infinity) > ttl)) {
          const raw = await options.request(e.url, { method: 'eth_getBlockByNumber', params: [pin, false] });
          if (raw === null) { quarantine(e); continue; }
          const canonical = block(raw);
          if (canonical.hash !== anchor.hash) { quarantine(e); continue; }
          anchor.checked.set(i, now());
        }
        const result = await options.request(e.url, request);
        if ((request.method === 'eth_getBlockByNumber' || request.method === 'eth_getBlockByHash') && result !== null) {
          const observed = block(result);
          if (request.method === 'eth_getBlockByNumber' && request.params?.[0] === 'finalized') {
            if (finalized && BigInt(observed.number) < BigInt(finalized.number)) {
              quarantine(e); continue; // Discard only the lagging view; retain every saved anchor.
            }
            if (finalized && (BigInt(observed.timestamp) < BigInt(finalized.timestamp)
              || BigInt(observed.number) === BigInt(finalized.number) && observed.hash !== finalized.hash))
              throw new Error('RPC_POOL_BLOCK_CHANGED');
            remember(observed, i);
            finalized = observed;
          } else remember(observed, i);
        }
        if (request.method === 'eth_chainId' && result !== `0x${options.chainId.toString(16)}`) { quarantine(e); continue; }
        e.failures = 0;
        return result;
      } catch (error) {
        if (probing && e.until > now()) continue; // Failed health probe already quarantined this endpoint.
        if (!transient(error)) throw error;
        quarantine(e);
      } finally { e.inFlight--; for (const wake of waiting) wake(); waiting.clear(); }
    }
    if (now() < deadline && states.some(e => now() >= e.until && e.inFlight >= e.capacity)) {
      // Bounded backpressure for a wide multicall snapshot, rather than an unbounded queue.
      await new Promise<void>(resolve => {
        const wake = () => { clearTimeout(timer); waiting.delete(wake); resolve(); };
        const timer = setTimeout(wake, Math.min(1000, Math.max(1, deadline - now())));
        waiting.add(wake);
      });
      return run(request, deadline);
    }
    throw new Error('RPC_POOL_UNAVAILABLE');
  }
  return {
    request(request: PoolRequest): Promise<unknown> {
      // Coalesce only concurrent identical reads; never cache mutable chain state.
      const key = JSON.stringify(request), existing = pending.get(key);
      if (existing) return existing;
      if (pending.size >= 128) return Promise.reject(new Error('RPC_POOL_BUSY'));
      const promise = run(request).finally(() => { pending.delete(key); });
      pending.set(key, promise); return promise;
    },
    // Safe operational metrics: provider indices only, never credential-bearing URLs.
    status: () => states.map((e, i) => ({ provider: i, inFlight: e.inFlight, capacity: e.capacity,
      cooling: e.until > now(), healthy: now() - e.checkedAt < ttl, headTime: e.headTime })),
  };
}
