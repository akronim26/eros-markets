// Exact-integer units. No floating point touches an amount (frontend.md R1).
export {
  Q,
  WAD,
  ATOMS_PER_USDC,
  LOTS_PER_CLAIM,
  qToMoney,
  lotsToClaims,
  wadToPrice,
  formatAtoms,
} from "@eros/risk-sdk";

const WAD_ = 10n ** 18n;

export function parseUsdcToAtoms(s: string): bigint {
  const m = /^(\d+)(?:\.(\d{0,6}))?$/.exec(s.trim());
  if (!m) throw new Error("Amount: up to 6 decimals");
  const amount = BigInt(m[1]) * 1_000_000n + BigInt((m[2] ?? "").padEnd(6, "0") || "0");
  if (amount > (1n << 256n) - 1n) throw new Error("Amount exceeds the contract limit");
  return amount;
}

export function parseClaimsToLots(s: string): bigint {
  const m = /^(\d+)(?:\.(\d{0,3}))?$/.exec(s.trim());
  if (!m) throw new Error("Size: up to 3 decimals (1 lot = 0.001 claim)");
  const lots = BigInt(m[1]) * 1000n + BigInt((m[2] ?? "").padEnd(3, "0") || "0");
  if (lots > (1n << 64n) - 1n) throw new Error("Size exceeds the contract limit");
  return lots;
}

export function parsePriceToTick(s: string): number {
  const m = /^0?\.(\d{1,3})$/.exec(s.trim());
  const tick = m ? Number(m[1].padEnd(3, "0")) : 0;
  if (tick < 1 || tick > 999) throw new Error("Price: 0.001 to 0.999");
  return tick;
}

export const tickToPrice = (tick: number) => (tick / 1000).toFixed(3);

/** WAD probability as a 3-decimal price string (truncated, display only). */
export function wadTo3(wad: bigint): string {
  const milli = (wad * 1000n) / WAD_;
  return `${milli / 1000n}.${(milli % 1000n).toString().padStart(3, "0")}`;
}

/** WAD → number in [0,1] for chart geometry only, never for amounts. */
export const wadToUnit = (wad: bigint) => Number((wad * 1_000_000n) / WAD_) / 1_000_000;

export const buyBackedAtoms = (lots: bigint, tick: number) => lots * BigInt(tick);
export const sellBackedAtoms = (lots: bigint, tick: number) => lots * BigInt(1000 - tick);

export function atomsToUsdc(atoms: bigint, dp = 2): string {
  const neg = atoms < 0n;
  const a = neg ? -atoms : atoms;
  const whole = a / 1_000_000n;
  const frac = (a % 1_000_000n).toString().padStart(6, "0").slice(0, dp);
  return `${neg ? "−" : ""}${whole.toLocaleString("en-US")}${dp > 0 ? `.${frac}` : ""}`;
}

export function shortAddr(a: string) {
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}

export function fmtDuration(secs: bigint | number): string {
  let s = Number(secs);
  if (s <= 0) return "0s";
  const d = Math.floor(s / 86400);
  s -= d * 86400;
  const h = Math.floor(s / 3600);
  s -= h * 3600;
  const m = Math.floor(s / 60);
  const sec = s - m * 60;
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m ${sec}s`;
  return `${m}m ${sec}s`;
}

export function fmtUtc(ts: bigint | number): string {
  const d = new Date(Number(ts) * 1000);
  return `${d.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}
