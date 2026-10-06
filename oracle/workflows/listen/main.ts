// Durable event intake; only the real CRE CLI executes the workflow and sends reports.
import { closeSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createPublicClient, http, parseAbi, parseAbiItem, type Hex } from 'viem'
import { enqueue, nextRange, receiptIndex, validateCheckpoint, type Checkpoint, type Request } from './poller'

const workflows = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const target = process.env.TARGET ?? 'local-sim'
if (!['local-sim', 'fresh-testnet'].includes(target)) throw new Error('This listener only supports configured testnet simulation targets')
const broadcast = process.env.BROADCAST !== '0'
const rpc = process.env.MONAD_TESTNET_RPC
if (!rpc) throw new Error('MONAD_TESTNET_RPC is required (load workflows/.env)')
const cfg = JSON.parse(readFileSync(join(workflows, `resolution/config.${target}.json`), 'utf8'))
const oracle = cfg.oracle as Hex
const stateDir = resolve(process.env.STATE_DIR ?? join(workflows, 'listen/logs'))
const envFile = resolve(process.env.CRE_ENV_FILE ?? join(workflows, '.env'))
const cre = process.env.CRE_BIN ?? 'cre'
const client = createPublicClient({ transport: http(rpc, { timeout: 20_000 }) })
const chainId = await client.getChainId()
if (chainId !== 10143) throw new Error('Expected Monad testnet chain ID 10143')
const eventABI = parseAbiItem('event ResolutionRequested(bytes32 indexed marketId,uint64 requestedAt,uint32 requestCount)')
const jobABI = parseAbi(['function getL1Job(bytes32) view returns (uint8)'])
const log = (event: string, data: object = {}) => console.log(JSON.stringify({ time: new Date().toISOString(), event, ...data }))
mkdirSync(stateDir, { recursive: true, mode: 0o700 })
const lock = join(stateDir, 'listener.lock')
// Fail closed on a stale lock; the operator must confirm its PID is dead before removing it.
mkdirSync(lock)
writeFileSync(join(lock, 'pid'), String(process.pid))
let stopped = false
let child: ReturnType<typeof Bun.spawn> | undefined
const stop = () => { stopped = true; child?.kill() }
process.on('SIGINT', stop)
process.on('SIGTERM', stop)
const path = join(stateDir, 'checkpoint.json')
const save = (s: Checkpoint) => {
  writeFileSync(`${path}.tmp`, JSON.stringify(s, null, 2) + '\n', { mode: 0o600 })
  renameSync(`${path}.tmp`, path)
}
const scope = { chainId, oracle, broadcast, target }
let state: Checkpoint
try {
  try { state = validateCheckpoint(JSON.parse(readFileSync(path, 'utf8')), scope) }
  catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
    const head = await client.getBlock({ blockTag: 'finalized' })
    const start = process.env.START_BLOCK
    if (start !== undefined && !/^\d+$/.test(start)) throw new Error('START_BLOCK must be a decimal block number')
    state = { version: 1, ...scope, nextBlock: start ?? String(head.number > 99n ? head.number - 99n : 0n), pending: [] }
    save(state)
    log('initialized', { nextBlock: state.nextBlock, broadcast })
  }
  const processRequest = async (request: Request) => {
    const stateOf = () => client.readContract({ address: oracle, abi: jobABI, functionName: 'getL1Job', args: [request.market], blockTag: 'latest' })
    if (await stateOf() !== 3) {
      log('skip', { market: request.market, reason: 'no longer L1Pending' })
      return true
    }
    const receipt = await client.getTransactionReceipt({ hash: request.tx })
    const index = receiptIndex(receipt.logs, request)
    const output = join(stateDir, `cre-${request.tx}-${request.logIndex}-${Date.now()}.log`)
    const args = [cre, 'workflow', 'simulate', 'resolution', '--target', target, '--limits', 'default', '--trigger-index', '0',
      '--evm-tx-hash', request.tx, '--evm-event-index', String(index), '--non-interactive', '-e', envFile]
    if (broadcast) args.push('--broadcast')
    log('simulate', { market: request.market, tx: request.tx, receiptIndex: index, output, broadcast })
    // A failed/ambiguous attempt stays queued. On retry/restart, read chain state before executing again.
    request.retryAt = Date.now() + 60_000
    save(state)
    const fd = openSync(output, 'w', 0o600)
    let code: number
    try {
      child = Bun.spawn(args, { cwd: workflows, stdout: fd, stderr: fd })
      const timeout = setTimeout(() => child?.kill(), 180_000)
      try { code = await child.exited } finally { clearTimeout(timeout); child = undefined }
    } finally { closeSync(fd) }
    const text = readFileSync(output, 'utf8')
    const result = text.match(new RegExp(`(?:proposed|skip|nowrite|noconsensus|error|write_failed):${request.market}[^\\s"\\x1b]*`, 'i'))?.[0]
    const accepted = broadcast ? await stateOf() !== 3 : code === 0 && result?.startsWith('proposed:') === true
    log('result', { market: request.market, code, result: result ?? 'no workflow result', accepted })
    return accepted
  }
  while (!stopped) {
    try {
      const head = await client.getBlock({ blockTag: 'finalized' })
      if (state.anchor) {
        const block = await client.getBlock({ blockNumber: BigInt(state.anchor.number) })
        if (block.hash !== state.anchor.hash) throw new Error('Checkpoint block hash changed; refusing to advance')
      }
      for (let n = 0; n < 20 && !stopped; n++) {
        const range = nextRange(BigInt(state.nextBlock), head.number)
        if (!range) break
        const [fromBlock, toBlock] = range
        const logs = await client.getLogs({ address: oracle, event: eventABI, fromBlock, toBlock, strict: true })
        const block = await client.getBlock({ blockNumber: toBlock })
        state = enqueue(state, logs.map(l => ({ tx: l.transactionHash, block: String(l.blockNumber), logIndex: l.logIndex, market: l.args.marketId, retryAt: 0 })), toBlock, block.hash)
        save(state)
      }
      for (const request of [...state.pending]) {
        if (stopped) break
        if (request.retryAt > Date.now()) continue
        try {
          if (await processRequest(request)) state.pending = state.pending.filter(p => p !== request)
        } catch {
          // RPC errors may include credentials in their URLs; detailed provider errors stay out of service logs.
          request.retryAt = Date.now() + 60_000
          log('request-retry', { market: request.market })
        }
        save(state)
      }
      log('tick', { finalized: String(head.number), nextBlock: state.nextBlock, pending: state.pending.length })
    } catch (error) {
      const changed = error instanceof Error && error.message === 'Checkpoint block hash changed; refusing to advance'
      log(changed ? 'checkpoint-hash-mismatch' : 'poll-retry', { nextBlock: state.nextBlock })
      if (process.env.RUN_ONCE === '1') process.exitCode = 1
    }
    if (process.env.RUN_ONCE === '1') {
      if (state.pending.length > 0) process.exitCode = 1
      break
    }
    for (let i = 0; i < 5 && !stopped; i++) await Bun.sleep(1000)
  }
} finally {
  child?.kill()
  rmSync(lock, { recursive: true, force: true })
}
