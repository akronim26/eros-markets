import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { Hex } from 'viem'
import { viemTransport } from './chain'
import { Operations, type Command } from './operations'
import { binding, envelopeSchema, incidentSchema, manifestSchema } from './schema'
import { FileStore } from './store'

const usage = 'bun src/main.ts <sample|liquidate|rollover|early-check|relay> <manifest.json> <journal.json> [incident-or-envelope.json] [--broadcast] [--watch]'

async function main() {
  const flags = new Set(process.argv.slice(2).filter(value => value.startsWith('--')))
  if ([...flags].some(value => value !== '--broadcast' && value !== '--watch')) throw new Error(usage)
  const args = process.argv.slice(2).filter(value => !value.startsWith('--'))
  const [action, manifestPath, journalPath, inputPath] = args
  if (!manifestPath || !journalPath || !['sample', 'liquidate', 'rollover', 'early-check', 'relay'].includes(action ?? '') || args.length !== (action === 'sample' || action === 'liquidate' || action === 'rollover' ? 3 : 4)) throw new Error(usage)
  const readJson = (path: string) => JSON.parse(readFileSync(resolve(path), 'utf8'))
  const manifest = manifestSchema.parse(readJson(manifestPath))
  const rpcUrl = process.env.RPC_URL
  if (!rpcUrl || !/^https?:\/\//.test(rpcUrl)) throw new Error('Set RPC_URL to the intended network endpoint')
  const broadcast = flags.has('--broadcast')
  const privateKey = broadcast ? process.env.MARKET_OPS_PRIVATE_KEY : undefined
  if (broadcast && !/^0x[0-9a-fA-F]{64}$/.test(privateKey ?? '')) throw new Error('Broadcast requires MARKET_OPS_PRIVATE_KEY')
  const command: Command = action === 'sample' || action === 'liquidate' || action === 'rollover'
    ? { action }
    : action === 'early-check'
      ? { action, incident: incidentSchema.parse(readJson(inputPath!)) }
      : { action: 'relay', envelope: envelopeSchema.parse(readJson(inputPath!)) }
  const pollMs = Number(process.env.POLL_MS ?? '5000')
  if (!Number.isSafeInteger(pollMs) || pollMs < 1000) throw new Error('POLL_MS must be an integer of at least 1000')
  const transport = viemTransport(manifest, rpcUrl, privateKey as Hex | undefined)
  const store = new FileStore(resolve(journalPath), binding(manifest))
  const operations = new Operations(manifest, transport, store)
  let stopped = false
  const stop = () => { stopped = true }
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
  try {
    do {
      const result = await operations.tick(command, broadcast)
      console.log(JSON.stringify(result))
      if (!flags.has('--watch') || ['complete', 'obsolete', 'halted'].includes(result.outcome)) break
      if (command.action === 'relay' && result.outcome === 'finalized' && result.action === 'relay') break
      await new Promise(resolveDelay => setTimeout(resolveDelay, pollMs))
    } while (!stopped)
  } finally {
    process.off('SIGINT', stop)
    process.off('SIGTERM', stop)
    store.close()
  }
}

try {
  await main()
} catch (error) {
  let message = error instanceof Error ? error.message : 'Operation failed'
  for (const secret of [process.env.RPC_URL, process.env.MARKET_OPS_PRIVATE_KEY]) {
    if (secret) message = message.replaceAll(secret, '[redacted]')
  }
  console.error(message)
  process.exitCode = 1
}
