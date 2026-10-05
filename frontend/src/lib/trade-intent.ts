export type CloseIntent = { nonce: number; side: "buy" | "sell"; size: string; price: string };
export function expiryBlock(input: string, current: bigint) {
  if (!input.trim()) return 0;
  if (!/^\d+$/.test(input)) throw new Error("Expiry must be a block number");
  const block = BigInt(input);
  if (block <= current || block > 0xffffffffn) throw new Error("Expiry must be a future block below 4,294,967,296");
  return Number(block);
}
export function closeIntent(lots: bigint, bid: number, ask: number, bps = 10000): CloseIntent {
  if (!lots || !Number.isInteger(bps) || bps < 1 || bps > 10000) throw new Error("No position to reduce");
  const size = (lots < 0n ? -lots : lots) * BigInt(bps) / 10000n;
  if (!size) throw new Error("Reduction is below one lot");
  const tick = lots > 0n ? bid : ask;
  return { nonce: Date.now(), side: lots > 0n ? "sell" : "buy", size: `${size / 1000n}.${String(size % 1000n).padStart(3, "0")}`, price: tick ? `0.${String(tick).padStart(3, "0")}` : "" };
}
