import { PublicError } from "@/lib/public-error";
import { db } from "./store";

/** Enforce the owner limit at insertion, after asynchronous chain verification. */
export function insertProtectionRule(rule: { id: string; user: string; wallet: string; engine: string; body: string; created: number }) {
  const store = db();
  store.exec("BEGIN IMMEDIATE");
  try {
    const count = store.prepare("SELECT count(*) AS n FROM rules WHERE user=? AND status IN ('active','sending','uncertain')").get(rule.user) as { n: number };
    if (count.n >= 20) throw new PublicError("At most 20 active or unresolved protection rules are allowed per user.");
    store.prepare("INSERT INTO rules(id,user,wallet,engine,body,status,created) VALUES (?,?,?,?,?,'active',?)")
      .run(rule.id, rule.user, rule.wallet.toLowerCase(), rule.engine.toLowerCase(), rule.body, rule.created);
    store.exec("COMMIT");
  } catch (error) {
    store.exec("ROLLBACK");
    throw error;
  }
}
