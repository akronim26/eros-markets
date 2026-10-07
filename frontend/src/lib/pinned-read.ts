import { canonicalRead } from "./deployment-check";
import { client } from "./public-client";
import { PublicError } from "./public-error";

export interface PinnedRead<T> { value: T; block: bigint; timestamp: bigint }

/** Keep canonical block provenance when a polled query uses a stable cache key. */
export async function readPinned<T>(block: bigint, read: () => Promise<T>): Promise<PinnedRead<T>> {
  const data = await canonicalRead(block, async () => {
    const [value, anchor] = await Promise.all([read(), client.getBlock({ blockNumber: block })]);
    return { value, block, timestamp: anchor.timestamp };
  });
  if (!pinnedReadCurrent(data, block)) throw new PublicError("Read block is stale or has an invalid timestamp. Refresh and retry.");
  return data;
}

/** Callers must also guard owner/input/phase identities specific to their result. */
export function pinnedReadCurrent(data: PinnedRead<unknown> | undefined, currentBlock: bigint | undefined, now = Date.now()) {
  if (!data || currentBlock === undefined || data.block > currentBlock) return false;
  const age = now - Number(data.timestamp) * 1000;
  return age >= -5000 && age <= 30000;
}
