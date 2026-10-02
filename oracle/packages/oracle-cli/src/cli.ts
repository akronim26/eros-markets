#!/usr/bin/env bun
// oracle-cli (ADJ-13). Commands: `list` (O22.2).
import { parseArgs } from 'node:util'
import { ForgeError } from './forge'
import { list, ListError } from './list'

const USAGE = `usage: oracle-cli list --input <listing.json> [options]

  --network <name>         params.<name>.json and deployments/<name>.json (default monad-testnet)
  --reference <file>       use this captured response instead of fetching the reference URL
  --out <dir>              where listings/<marketId>/ is written (default oracle/listings)
  --oracle <address>       oracle address in the claim preview (default deployments/<network>.json)
  --chain-id <id>          chain id in the claim preview (default params.<network>.json)
  --providers <a,b>        hosts assumed on the provider list in the createMarket dry-run
  --now <unix>             listing time of the dry-run (default now)
  --no-check               skip the createMarket dry-run
  --force                  replace an existing pack directory`

async function main(argv: string[]): Promise<number> {
  const { positionals, values } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      input: { type: 'string' },
      network: { type: 'string' },
      reference: { type: 'string' },
      out: { type: 'string' },
      oracle: { type: 'string' },
      'chain-id': { type: 'string' },
      providers: { type: 'string' },
      now: { type: 'string' },
      'no-check': { type: 'boolean' },
      force: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  })
  if (values.help || positionals[0] !== 'list' || !values.input) {
    console.error(USAGE)
    return values.help ? 0 : 2
  }
  try {
    const r = await list({
      input: values.input,
      network: values.network,
      referenceFile: values.reference,
      out: values.out,
      oracle: values.oracle,
      chainId: values['chain-id'] ? BigInt(values['chain-id']) : undefined,
      providers: values.providers ? values.providers.split(',').filter((h) => h !== '') : undefined,
      now: values.now ? BigInt(values.now) : undefined,
      check: !values['no-check'],
      force: values.force,
    })
    console.log(`market    ${r.marketId}`)
    console.log(`pack      ${r.dir}`)
    console.log(`reference ${r.reference.url}: ${r.reference.status}, valueHash ${r.reference.valueHash}`)
    console.log(`dryRunHash ${r.dryRunHash}`)
    console.log(`claim     ${r.claimBytes} bytes (worst case ${r.worstCase}, max ${r.maxClaimBytes})`)
    console.log(r.check ? `createMarket dry-run: ok\n${r.check}` : 'createMarket dry-run: skipped (--no-check)')
    return 0
  } catch (e) {
    if (e instanceof ListError || e instanceof ForgeError) {
      console.error(`oracle-cli list: ${e.message}`)
      return 1
    }
    throw e
  }
}

if (import.meta.main) process.exit(await main(Bun.argv.slice(2)))
