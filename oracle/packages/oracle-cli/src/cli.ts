#!/usr/bin/env bun
// oracle-cli (ADJ-13). Commands: `list` (O22.2), `dryrun` and `ambiguity` (O22.3).
import { parseArgs } from 'node:util'
import { ForgeError } from './forge'
import { ambiguity, applyTriage, TRIAGE_FILE } from './ambiguity'
import { dryRun } from './dryrun'
import { list, ListError } from './list'
import { ModelError } from './models'

const USAGE = `usage: oracle-cli list --input <listing.json> [options]

  --network <name>         params.<name>.json and deployments/<name>.json (default monad-testnet)
  --reference <file>       use this captured response instead of fetching the reference URL
  --out <dir>              where listings/<marketId>/ is written (default oracle/listings)
  --oracle <address>       oracle address in the claim preview (default deployments/<network>.json)
  --chain-id <id>          chain id in the claim preview (default params.<network>.json)
  --providers <a,b>        hosts assumed on the provider list in the createMarket dry-run
  --now <unix>             listing time of the dry-run (default now)
  --no-check               skip the createMarket dry-run
  --force                  replace an existing pack directory

usage: oracle-cli dryrun --input <listing.json> --nodes <N> [--network <name>] [--out <dir>]

  Burst test (N parallel GETs of the reference event, one per DON node, all HTTP 200) and three
  \`cre workflow simulate dryrun\` runs (finished -> the reference's YES/NO, dryRun.liveUrlParam ->
  NOT_READY, wrong value path -> ERROR). Writes dryrun.log into the pack; exits 1 on any mismatch.

usage: oracle-cli ambiguity --input <listing.json> [--out <dir>] [--triage <ambiguity-triage.json>]

  Gives the question and rules to the three models of ambiguity.models (checked against
  ai.modelIdHashes; keys ANTHROPIC_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY, GROQ_API_KEY,
  MISTRAL_API_KEY, CEREBRAS_API_KEY,
  NVIDIA_API_KEY). Writes ambiguity.log and,
  when no model lists an undecided case, sets ambiguityLogHash in pack.json; exits 1 otherwise. When
  every model answered but some listed cases, the pass is NEEDS_TRIAGE and ambiguity-triage.json is
  written into the pack: give each case "decided" (with a clause quoted from the rules) or "immaterial"
  (with a reason), set triagedBy, then run with --triage <that file> (no model calls) to record it and set the hash.`

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
      nodes: { type: 'string' },
      triage: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  })
  const command = positionals[0]
  if (values.help || !['list', 'dryrun', 'ambiguity'].includes(command) || !values.input) {
    console.error(USAGE)
    return values.help ? 0 : 2
  }
  try {
    if (command === 'dryrun') {
      const r = await dryRun({ input: values.input, nodes: Number(values.nodes), network: values.network, out: values.out })
      process.stdout.write(r.log)
      console.log(`wrote ${r.dir}/dryrun.log`)
      return r.pass ? 0 : 1
    }
    if (command === 'ambiguity' && values.triage !== undefined) {
      const r = applyTriage({ input: values.input, out: values.out, triage: values.triage || undefined })
      console.log(`triage recorded in ${r.dir}/ambiguity.log; PASS_TRIAGED, ambiguityLogHash ${r.ambiguityLogHash}`)
      return 0
    }
    if (command === 'ambiguity') {
      const r = await ambiguity({ input: values.input, out: values.out })
      for (const run of r.runs) {
        const what = run.error ? `error: ${run.error}` : `${run.undecided!.length} undecided`
        console.log(`${run.model}: ${what}`)
        for (const u of run.undecided ?? []) console.log(`  - ${u.case}: ${u.why}`)
      }
      const next = {
        PASS: `PASS, ambiguityLogHash ${r.ambiguityLogHash}`,
        NEEDS_TRIAGE: `NEEDS_TRIAGE: fix the rules and re-run list and the pass, or give every case a disposition in ${r.dir}/${TRIAGE_FILE} and run with --triage`,
        FAIL: 'FAIL (a model did not answer validly): run the pass again',
        PASS_TRIAGED: '',
      }[r.result]
      console.log(`wrote ${r.dir}/ambiguity.log; ${next}`)
      return r.pass ? 0 : 1
    }
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
    if (e instanceof ListError || e instanceof ForgeError || e instanceof ModelError) {
      console.error(`oracle-cli ${command}: ${e.message}`)
      return 1
    }
    throw e
  }
}

if (import.meta.main) process.exit(await main(Bun.argv.slice(2)))
