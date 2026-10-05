import { reconcileRequest } from "../src/server/reconcile";
async function main() {
  const [id, transaction] = process.argv.slice(2);
  if (!id || !transaction) throw new Error("Usage: npm run automation:reconcile -- REQUEST_ID PRIVY_TRANSACTION_ID");
  console.log(await reconcileRequest(id, transaction));
}
main().catch((error) => { console.error(error instanceof Error && error.constructor === Error ? error.message : "Reconciliation failed; no request was cleared."); process.exitCode = 1; });
