// Runs one scenario against Monad testnet: `bun e2e/src/main.ts <DRY|O23|E1|...|E9>`.
//
//   SOURCES         the panel runner's SOURCES file (scenarios add pages for their markets)
//   SNAPSHOT_DIR    the panel runner's snapshot store (the committee console reads it)
//   INDEXER_URL     Envio GraphQL (E2 checks the dispute is indexed)
//   E2E_FROM_BLOCK  where the committee console starts reading logs
//   FORGE           the forge binary for the ListMarket script (default forge)
// Keys and the RPC come from oracle/workflows/.env and oracle/deployments/testnet-keys.env.
import { Evidence } from './evidence'
import { SCENARIOS } from './scenarios'

const name = (process.argv[2] ?? '').toUpperCase()
const sc = SCENARIOS[name]
if (!sc) {
  console.error(`usage: bun e2e/src/main.ts <${Object.keys(SCENARIOS).join('|')}>`)
  process.exit(2)
}
const ev = new Evidence(name, sc.title)
try {
  await sc.run(ev)
  process.exit(ev.finish() ? 0 : 1)
} catch (e) {
  ev.log(String(e))
  ev.finish(e)
  process.exit(1)
}
