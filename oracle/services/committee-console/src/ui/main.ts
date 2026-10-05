#!/usr/bin/env bun
// `bun run console <command> …` (commands in console.ts). Keys are testnet-only hot keys.
//
//   NETWORK                deployments/<NETWORK>.json (default monad-testnet)
//   RPC_URL                the reviewer's RPC endpoint
//   COMMITTEE_PRIVATE_KEY  the reviewer's committee key (propose, sign)
//   RELAYER_PRIVATE_KEY    the EOA that submits and pays gas
//   SNAPSHOT_DIR           the store shared with the panel runner (default ./snapshots)
//   DATA_DIR               the console's cases and proposals (default ./committee)
//   FROM_BLOCK             where log reads start (default the oracle's deploy block)
import { loadDeployments, loadGas } from '@eros-oracle/oracle-sdk'
import { takeSnapshot } from '@eros-oracle/snapshotter'
import type { Address, Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { z } from 'zod'
import { viemCaseChain } from '../backend/chain'
import { EvidenceStore } from '../backend/store'
import { CommitteeConsole, parseChoice } from './console'

const COMMANDS = ['case', 'snapshot', 'propose', 'sign', 'typed-data', 'add-sig', 'status', 'submit', 'alerts']
const [cmd, ...args] = process.argv.slice(2)
const usage = `usage: console case <id> | snapshot <id> [url ...] | propose <id> <YES|NO|INVALID> <note> | sign <bundle> <YES|NO|INVALID>
       | typed-data <bundle> | add-sig <bundle> <signer> <signature> | status <bundle> | submit <bundle> | alerts`
if (!COMMANDS.includes(cmd)) {
  console.error(usage)
  process.exit(2)
}

const key = z.string().regex(/^0x[0-9a-fA-F]{64}$/)
const env = z
  .object({
    NETWORK: z.string().default('monad-testnet'),
    RPC_URL: z.url(),
    COMMITTEE_PRIVATE_KEY: key.optional(),
    RELAYER_PRIVATE_KEY: key.optional(),
    SNAPSHOT_DIR: z.string().default('snapshots'),
    DATA_DIR: z.string().default('committee'),
    FROM_BLOCK: z.coerce.bigint().optional(),
  })
  .parse(process.env)

const json = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x), 2)
const con = new CommitteeConsole({
  chain: viemCaseChain({ rpcUrl: env.RPC_URL, deployments: loadDeployments(env.NETWORK), relayerKey: env.RELAYER_PRIVATE_KEY as Hex | undefined, fromBlock: env.FROM_BLOCK }),
  store: new EvidenceStore(env.SNAPSHOT_DIR),
  gas: loadGas(),
  takeSnapshot: (req) => takeSnapshot(req),
  account: env.COMMITTEE_PRIVATE_KEY ? privateKeyToAccount(env.COMMITTEE_PRIVATE_KEY as Hex) : undefined,
  dataDir: env.DATA_DIR,
})

const need = (n: number) => {
  if (args.length < n) {
    console.error(usage)
    process.exit(2)
  }
}
try {
  switch (cmd) {
    case 'case':
      need(1)
      console.log(await con.show(args[0] as Hex))
      break
    case 'snapshot':
      need(1)
      console.log(json(await con.snapshot(args[0] as Hex, args.slice(1))))
      break
    case 'propose': {
      need(3)
      const { path, bundle } = await con.propose(args[0] as Hex, parseChoice(args[1]), args.slice(2).join(' '))
      console.log(json({ path, proposal: bundle.proposal }))
      break
    }
    case 'sign':
      need(2)
      console.log(json((await con.sign(args[0], parseChoice(args[1]))).signatures.map((s) => s.signer)))
      break
    case 'typed-data':
      need(1)
      console.log(json(con.typedData(args[0])))
      break
    case 'add-sig':
      need(3)
      console.log(json(con.addSignature(args[0], args[1] as Address, args[2] as Hex).signatures.map((s) => s.signer)))
      break
    case 'status':
      need(1)
      console.log(json(await con.status(args[0])))
      break
    case 'submit':
      need(1)
      console.log(await con.submit(args[0]))
      break
    case 'alerts':
      console.log(json(await con.alerts()))
      break
    default:
      console.error(usage)
      process.exit(2)
  }
} catch (e) {
  console.error(e instanceof Error ? e.message : String(e))
  process.exit(1)
}
