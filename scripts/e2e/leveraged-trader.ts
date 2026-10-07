/** Real testnet 5x proof with the same sizing function as the frontend. */
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { privateKeyToAccount } from '../../frontend/node_modules/viem/accounts';
import { keccak256, parseEther, parseEventLogs, stringToHex, type Hex } from '../../frontend/node_modules/viem';
import { leverageLots } from '../../frontend/src/lib/leverage';
import { createTraderClient, transactionData } from '../../oracle/packages/oracle-sdk/src/trading';
import { toPublicManifest } from '../../oracle/packages/oracle-sdk/src/trading-manifest';
import { artifact, atomicWrite, client, executePlan, type Plan } from '../../oracle/e2e/src/fresh-testnet';
import { isTestnetProofDirectory } from './proof-directory.mjs';

const [directory, command, phase] = process.argv.slice(2);
if (!isTestnetProofDirectory(directory) || !['prepare', 'rehearse', 'broadcast'].includes(command)
  || !['open', 'close'].includes(phase)) throw Error('EXPLICIT_LEVERAGED_PROOF_REQUIRED');
const isBuy = (process.env.EROS_LEVERAGE_SIDE ?? 'buy') === 'buy';
if (!['buy', 'sell'].includes(process.env.EROS_LEVERAGE_SIDE ?? 'buy')) throw Error('INVALID_SIDE');
const root = directory + '/trader/leveraged-' + (isBuy ? 'buy' : 'sell');
mkdirSync(root, { recursive: true, mode: 0o700 });
const read = (p: string) => JSON.parse(readFileSync(p, 'utf8'));
const json = (v: unknown) => JSON.stringify(v, (_, v) => typeof v === 'bigint' ? v.toString() : v, 2) + '\n';
const base = read(directory + '/base-plan.json') as Plan;
const manifest = toPublicManifest(read(directory + '/market-verification.json').manifest);
const account = privateKeyToAccount(parseEnv(readFileSync(directory + '/trader/owner.env', 'utf8')).OWNER_PRIVATE_KEY as Hex);
const sdk = createTraderClient(manifest, manifest.markets[0].name, account.address);
const rpc = process.env.MONAD_TESTNET_RPC!, pc = client(rpc).public;
const abi = artifact('RegistryBookRiskEngine').abi, file = root + '/' + phase + '-plan.json';
try {
 if (await pc.getChainId() !== 10143) throw Error('WRONG_CHAIN');
 const b = await pc.getBlock({ blockTag: 'finalized' });
 if ((await pc.call({ data: `0x73${sdk.market.engine.slice(2)}3f60005260206000f3`, blockNumber: b.number })).data !== sdk.market.codehash) throw Error('ENGINE_CHANGED');
 if (command === 'prepare') {
  if (existsSync(file)) throw Error('PLAN_EXISTS');
  const readAt = (functionName: string, args: unknown[] = []) => pc.readContract({ address: sdk.market.engine, abi, functionName, args, blockNumber: b.number }) as Promise<any>;
  const [id, risk, caps, bba, nonce, pending] = await Promise.all([readAt('participantId', [account.address]), readAt('marketRiskView'), readAt('leverageCaps'), readAt('bestBidAsk'),
   pc.getTransactionCount({ address: account.address, blockTag: 'latest' }), pc.getTransactionCount({ address: account.address, blockTag: 'pending' })]);
  if (nonce !== pending) throw Error('OWNER_PENDING_TRANSACTION');
  const before = await readAt('previewAccount', [id]);
  if (!risk.indexAvailable || risk.accountingState !== 0) throw Error('WAIT_FOR_LIVE_PRICING');
  const opening = phase === 'open', side = opening ? isBuy : !isBuy;
  const tick = Number(bba[side ? 1 : 0]);
  if (tick < 1 || tick > 999) throw Error('NO_EXECUTABLE_QUOTE');
  if (opening && (!risk.markAvailable || caps[isBuy ? 0 : 1] < 5n || before.positionLots !== 0n
    || before.orders.bidLots || before.orders.askLots || before.cashQ <= 0n)) throw Error('FIVE_TIMES_NOT_READY');
  if (!opening && (before.positionLots === 0n || (before.positionLots > 0n) !== isBuy)) throw Error('OWNER_POSITION_CHANGED');
  const size = opening ? leverageLots(before.cashQ, tick, isBuy, 5, risk.markWad) : (before.positionLots > 0n ? before.positionLots : -before.positionLots);
  const order = { kind: 1, isBuy: side, reduceOnly: !opening, tick, size, maxFills: 8, expiryBlock: 0 };
  const preview = await pc.readContract({ ...sdk.previewOrder(id, order), blockNumber: b.number });
  if (preview.rejection || preview.acceptedCapLots !== size) throw Error('EXACT_SIZE_NOT_ADMITTED');
  const levels = opening ? await Promise.all([1, 2, 3, 4, 5].map(async x => {
    const lots = leverageLots(before.cashQ, tick, isBuy, x, risk.markWad);
    const p = await pc.readContract({ ...sdk.previewOrder(id, { ...order, size: lots }), blockNumber: b.number });
    if (p.rejection || p.acceptedCapLots !== lots) throw Error('INTEGER_LEVERAGE_PREVIEW_FAILED');
    return { leverage: x, size: lots, preview: p };
  })) : [];
  if ((await pc.getBlock({ blockNumber: b.number })).hash !== b.hash) throw Error('NONCANONICAL_PREVIEW');
  const tx = transactionData(sdk.placeOrder(order));
  atomicWrite(file, { ...base, deployer: account.address, startNonce: nonce, maxTotalGasCostWei: parseEther('0.35').toString(),
    steps: [{ name: phase, nonce, to: tx.to, data: tx.data }], proof: { order, before, levels, block: b.number, blockHash: b.hash, caps } });
  console.log(JSON.stringify({ prepared: phase, side: isBuy ? 'buy' : 'sell', size: size.toString(), owner: account.address }));
 } else {
  const plan = read(file), broadcast = command === 'broadcast';
  let executionDirectory = root;
  if (!broadcast) {
    executionDirectory = root + '/rehearsals/' + phase + '-' + Date.now();mkdirSync(executionDirectory, { recursive: true, mode: 0o700 });
    const fork = client('http://127.0.0.1:18568').public;
    if (!String(await fork.request({ method: 'web3_clientVersion' })).toLowerCase().includes('anvil')) throw Error('ANVIL_REQUIRED');
    await fork.request({ method: 'anvil_reset', params: [{ forking: { jsonRpcUrl: 'http://127.0.0.1:18569', blockNumber: Number(b.number) } }] } as never);
    await fork.request({ method: 'anvil_setBlockTimestampInterval', params: [1] } as never);
  } else {
    const proofPath = read(root + '/' + phase + '-rehearsal-proof.json').directory;
    if (typeof proofPath !== 'string' || !proofPath.startsWith(root + '/rehearsals/' + phase + '-')) throw Error('INVALID_REHEARSAL_PROOF');
    const proof = read(proofPath + '/' + phase + '-rehearsal-journal.json');
    if (proof.status !== 'passed' || proof.planHash !== keccak256(stringToHex(json(plan)))) throw Error('MATCHING_REHEARSAL_REQUIRED');
    const deadline = Date.now() + 180000;let ready = false;
    while (Date.now() < deadline) {
      const head = await pc.getBlock({ blockTag: 'finalized' });
      const [source, id] = await Promise.all([pc.readContract({ address: sdk.market.engine, abi, functionName: 'sourceState', args: [sdk.market.sourceId], blockNumber: head.number }) as Promise<any>,
        pc.readContract({ ...sdk.participantId(), blockNumber: head.number })]);
      if (head.timestamp >= source.lastObservedAt && head.timestamp - source.lastObservedAt <= 12n) {
        const p = await pc.readContract({ ...sdk.previewOrder(id, { ...plan.proof.order, size: BigInt(plan.proof.order.size) }), blockNumber: head.number });
        if (!p.rejection && p.acceptedCapLots === BigInt(plan.proof.order.size) && (phase === 'close' || p.id.markAvailable && !p.fullBackingRequired)
          && (await pc.getBlock({ blockNumber: head.number })).hash === head.hash) { ready = true; break; }
      }
      await new Promise(r => setTimeout(r, 1000));
    }
    if (!ready) throw Error('FRESH_ADMISSION_UNAVAILABLE');
  }
  await executePlan(plan, executionDirectory, broadcast ? rpc : 'http://127.0.0.1:18568', broadcast, phase, async (_plan, chain, journal) => {
    const receipt = journal.steps.at(-1).receipt, blockNumber = BigInt(receipt.blockNumber);
    const id = await chain.readContract({ ...sdk.participantId(), blockNumber });
    const after = await chain.readContract({ address: sdk.market.engine, abi, functionName: 'previewAccount', args: [id], blockNumber }) as any;
    const fills = parseEventLogs({ abi, eventName: 'Fill', logs: receipt.logs.filter((l: any) => l.address.toLowerCase() === sdk.market.engine.toLowerCase()) }) as any[];
    const size = BigInt(plan.proof.order.size), expected = phase === 'open' ? (isBuy ? size : -size) : 0n;
    if (fills.reduce((s, f) => s + f.args.size, 0n) !== size || after.positionLots !== expected) throw Error('EXACT_FILL_NOT_CONFIRMED');
    const leverageWad = phase === 'open' && after.id.markAvailable && after.markEquityQ > 0n
      ? size * 1000n * (isBuy ? after.id.markWad : 10n ** 18n - after.id.markWad) * 10n ** 18n / after.markEquityQ : null;
    if (phase === 'open' && (leverageWad === null || leverageWad < 49n * 10n ** 17n || leverageWad > 501n * 10n ** 16n)) throw Error('FIVE_TIMES_FILL_NOT_CONFIRMED');
    return { passed: true, scope: broadcast ? 'real testnet leveraged fill' : 'fork rehearsal only', phase, side: isBuy ? 'buy' : 'sell', owner: account.address,
      engine: sdk.market.engine, transaction: receipt.transactionHash, block: blockNumber, blockHash: receipt.blockHash,
      requestedLeverage: 5, leverageWad, size, before: plan.proof.before, after, integerPreviews: plan.proof.levels, fills: fills.map(f => f.args) };
  }, account);
  if (!broadcast) atomicWrite(root + '/' + phase + '-rehearsal-proof.json', { directory: executionDirectory });
 }
} catch (error) { console.error((error as Error).message.match(/^[A-Z_]+$/)?.[0] ?? 'LEVERAGED_PROOF_FAILED');process.exitCode = 1; }
