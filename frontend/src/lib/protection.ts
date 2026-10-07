import { PublicError } from "./public-error";
export const RULE_KINDS = ["stop_loss", "take_profit", "auto_cancel", "risk_guard", "backing_guard", "claim_delivery"] as const;
export type RuleKind = typeof RULE_KINDS[number];
export type ProtectionRule = { kind: RuleKind; triggerTick: number; limitTick: number; maxLots: string; long: boolean; expires: number };
export function validateRule(x: unknown, now: number): ProtectionRule {
  const r = x as ProtectionRule;
  if (!r || !RULE_KINDS.includes(r.kind) || !Number.isInteger(r.triggerTick) || r.triggerTick < 1 || r.triggerTick > 999 || !Number.isInteger(r.limitTick) || r.limitTick < 1 || r.limitTick > 999 || typeof r.maxLots !== "string" || !/^\d{1,20}$/.test(r.maxLots) || BigInt(r.maxLots) < 1n || BigInt(r.maxLots) >= 2n ** 64n || typeof r.long !== "boolean" || !Number.isInteger(r.expires) || r.expires <= now || r.expires > now + 604800) throw new PublicError("Invalid protection rule. Rules may last at most seven days.");
  return { kind: r.kind, triggerTick: r.triggerTick, limitTick: r.limitTick, maxLots: r.maxLots, long: r.long, expires: r.expires };
}
export type ProtectionSnapshot = { now: bigint; markAvailable: boolean; markWad: bigint; lots: bigint; status: number; e0: bigint; e1: bigint; secsToT: bigint; monitorRestricted: boolean; stage: number; halted: boolean; leveraged: boolean; claimable: bigint };
export function protectionDecision(rule: ProtectionRule, s: ProtectionSnapshot): "wait" | "expired" | "done" | "cancel" | "reduce" | "claim" {
  if (s.now >= BigInt(rule.expires)) return "expired";
  if (rule.kind === "claim_delivery") return s.claimable > 0n ? "claim" : "wait";
  if (s.halted) return "done";
  if (rule.kind === "auto_cancel") return s.monitorRestricted || s.stage >= 3 || s.secsToT <= 4500n ? "cancel" : "wait";
  if (s.lots === 0n || (s.lots > 0n) !== rule.long) return "done";
  if (!s.markAvailable) return "wait";
  if (rule.kind === "risk_guard") return s.leveraged && s.status >= 2 ? "reduce" : "wait";
  if (rule.kind === "backing_guard") return s.leveraged && s.secsToT <= 45000n && (s.e0 < 0n || s.e1 < 0n) ? "reduce" : "wait";
  const threshold = BigInt(rule.triggerTick) * 10n ** 15n;
  const upward = rule.kind === "take_profit" ? rule.long : !rule.long;
  return (upward ? s.markWad >= threshold : s.markWad <= threshold) ? "reduce" : "wait";
}
