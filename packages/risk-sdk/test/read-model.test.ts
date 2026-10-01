// B042: SDK read model against docs/app-state-fixtures.json. Run with node:test via tsx.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  decodeAccount,
  decodeMarket,
  decodeSettlementStatus,
  isClaimable,
  settlementPrice,
  qToMoney,
  lotsToClaims,
  type AccountRiskViewRaw,
  type MarketRiskViewRaw,
  type SettlementView,
  type ViewIdentity,
} from "../src/index";

const fx = JSON.parse(readFileSync(join(__dirname, "../../../docs/app-state-fixtures.json"), "utf8"));

const big = (o: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(o).map(([k, v]) => [k, typeof v === "string" && /^-?\d+$/.test(v) ? BigInt(v) : v]));

function identity(markAvailable: boolean, markWad?: string): ViewIdentity {
  const t = fx.identity_template;
  return {
    chainId: t.chainId,
    engine: t.engine,
    blockNumber: BigInt(t.blockNumber),
    asOfTime: BigInt(t.asOfTime),
    riskVersion: BigInt(t.riskVersion),
    profileHash: t.profileHash,
    markAvailable,
    markWad: markWad ? BigInt(markWad) : undefined,
  };
}

test("accounts decode with units, identity and labelled projections", () => {
  for (const c of fx.accounts) {
    const d = decodeAccount(big(c.raw) as unknown as AccountRiskViewRaw, big(c.accounting) as never, identity(c.markAvailable, c.markWad));
    const e = c.expected;
    assert.equal(d.authoritative, false, `${c.id}: SDK values are never authoritative`);
    assert.equal(d.identity.blockNumber, 1n, `${c.id}: carries block identity`);
    if ("cashUsdc" in e) assert.equal(d.cash.usdc, e.cashUsdc);
    if ("positionClaims" in e) assert.equal(d.positionClaims, e.positionClaims);
    if ("markEquityUsdc" in e) assert.equal(d.markEquity?.usdc ?? null, e.markEquityUsdc, `${c.id}: unavailable is undefined, not 0`);
    if ("initialUsdc" in e) assert.equal(d.initial?.usdc ?? null, e.initialUsdc);
    if ("health" in e) assert.equal(d.health, e.health);
    if ("liquidation" in e) assert.equal(d.liquidation, e.liquidation);
    if ("withdrawableAtoms" in e) assert.equal(d.withdrawableAtoms, BigInt(e.withdrawableAtoms));
    if ("graceEndsAt" in e) assert.equal(d.grace?.endsAt, BigInt(e.graceEndsAt));
    assert.equal(d.projections.kind, "estimate");
    assert.equal(d.projections.withdrawable, false, `${c.id}: projections are not withdrawable amounts`);
  }
});

test("projection does not change the withdrawable amount", () => {
  const c = fx.accounts[0];
  const d = decodeAccount(big(c.raw) as unknown as AccountRiskViewRaw, big(c.accounting) as never, identity(true, c.markWad));
  assert.ok(d.projections.premium.q > 0n);
  assert.equal(d.withdrawableAtoms, 0n);
});

test("markets decode stage, pricing and pending work", () => {
  for (const m of fx.markets) {
    const d = decodeMarket(big(m.raw) as unknown as MarketRiskViewRaw);
    const e = m.expected;
    assert.equal(d.stage, e.stage, m.id);
    if ("pricing" in e) assert.equal(d.pricing, e.pricing);
    if ("mark" in e) assert.equal(d.mark ?? null, e.mark, `${m.id}: unavailable mark is not a price`);
    if ("index" in e) assert.equal(d.index, e.index);
    assert.deepEqual(d.pending, e.pending);
    assert.equal(d.tradingPausedForSweep, e.tradingPausedForSweep);
  }
});

test("every settlement state is distinct and claimable only with claimsEnabled", () => {
  const seen = new Set<string>();
  for (const s of fx.settlements) {
    const v = big(s.raw) as unknown as SettlementView;
    const status = decodeSettlementStatus(v);
    assert.equal(status, s.expected.status, s.id);
    assert.equal(isClaimable(v), s.expected.claimable, `${s.id}: claimable`);
    if (isClaimable(v)) assert.equal(v.claimsEnabled, true);
    if ("price" in s.expected) {
      const p = settlementPrice(v);
      assert.equal(p === undefined ? null : p.toString(), s.expected.price, `${s.id}: price`);
    }
    seen.add(status);
  }
  for (const want of ["LIVE", "HALTED_AWAITING_OUTCOME", "ORACLE_FINAL_PRICE_PENDING", "ORACLE_FINAL_PREPARING", "RECOVERY_REQUIRED", "CLAIMABLE", "COMPLETE"]) {
    assert.ok(seen.has(want), `fixture covers ${want}`);
  }
});

test("oracle finality alone is never claimable", () => {
  const v = big(fx.settlements.find((s: { id: string }) => s.id === "final_preparing").raw) as unknown as SettlementView;
  assert.equal(v.oracleFinalityAccepted, true);
  assert.equal(isClaimable(v), false);
});

test("unit helpers floor Q to atoms toward negative infinity", () => {
  assert.equal(qToMoney(-1n).atomsFloor, -1n);
  assert.equal(qToMoney(10n ** 18n - 1n).atomsFloor, 0n);
  assert.equal(qToMoney(10_421n * 10n ** 18n).usdc, "0.010421");
  assert.equal(lotsToClaims(17n), "0.017");
  assert.equal(lotsToClaims(-1_000_000n), "-1000.000");
});
