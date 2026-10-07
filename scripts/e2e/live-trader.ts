/** Bounded third-owner testnet custody/trade proof. No browser wallet is impersonated. */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { generatePrivateKey, privateKeyToAccount } from '../../frontend/node_modules/viem/accounts';
import { encodeFunctionData, keccak256, parseEther, parseEventLogs, stringToHex, type Hex } from '../../frontend/node_modules/viem';
import { createTraderClient, transactionData } from '../../oracle/packages/oracle-sdk/src/trading';
import { toPublicManifest } from '../../oracle/packages/oracle-sdk/src/trading-manifest';
import { artifact, atomicWrite, client, executePlan, type Plan, type Step } from '../../oracle/e2e/src/fresh-testnet';

const [directory, command, phase, rehearsalRpc] = process.argv.slice(2);
const phases = ['gas', 'funding', 'buy', 'close', 'release', 'withdraw'];
if (!directory?.startsWith('tmp/live-markets-') || !['prepare', 'rehearse', 'broadcast'].includes(command) || !phases.includes(phase)) throw Error('EXPLICIT_TESTNET_PROOF_REQUIRED');
const gasFundingInput = process.env.EROS_TRADER_GAS_MON ?? '0.6';
if (!/^[0-3](?:\.\d{1,3})?$/.test(gasFundingInput)) throw Error('INVALID_TRADER_GAS_FUNDING');
const gasFundingWei = parseEther(gasFundingInput);
if (gasFundingWei < parseEther('0.6') || gasFundingWei > parseEther('3')) throw Error('INVALID_TRADER_GAS_FUNDING');
const read = (file: string) => JSON.parse(readFileSync(file, 'utf8'));
const base = read(directory + '/base-plan.json') as Plan;
const manifest = toPublicManifest(read(directory + '/market-verification.json').manifest);
const ownerRoot = directory + '/trader';
const attempt = process.env.EROS_TRADER_ATTEMPT;
if (attempt && (!/^[1-9][0-9]{0,2}$/.test(attempt) || !['buy', 'close'].includes(phase))) throw Error('INVALID_TRADE_ATTEMPT');
const root = attempt ? `${ownerRoot}/attempts/${phase}-${attempt}` : ownerRoot;
mkdirSync(root, { recursive: true, mode: 0o700 });
const keyFile = ownerRoot + '/owner.env';
if (!existsSync(keyFile)) writeFileSync(keyFile, `OWNER_PRIVATE_KEY=${generatePrivateKey()}\n`, { mode: 0o600, flag: 'wx' });
const account = privateKeyToAccount(parseEnv(readFileSync(keyFile, 'utf8')).OWNER_PRIVATE_KEY as Hex);
const sdk = createTraderClient(manifest, manifest.markets[0].name, account.address);
const rpc = process.env.MONAD_TESTNET_RPC!;
const pc = client(rpc).public;
const abi = artifact('RegistryBookRiskEngine').abi;
const file = `${root}/${phase}-plan.json`;
const json = (value: unknown) => JSON.stringify(value, (_, v) => typeof v === 'bigint' ? v.toString() : v, 2) + '\n';

try {
  if (await pc.getChainId() !== 10143 || manifest.chainId !== 10143) throw Error('WRONG_CHAIN');
  const block = await pc.getBlock({ blockTag: 'finalized' });
  if ((await pc.call({ data: `0x73${sdk.market.engine.slice(2)}3f60005260206000f3`, blockNumber: block.number })).data !== sdk.market.codehash) throw Error('ENGINE_CHANGED');
  if (command === 'prepare') {
    if (existsSync(file)) throw Error('PLAN_EXISTS');
    const owner = phase === 'gas' ? base.deployer : account.address;
    const [nonce, pending] = await Promise.all(['latest', 'pending'].map(blockTag => pc.getTransactionCount({ address: owner, blockTag: blockTag as 'latest' | 'pending' })));
    if (nonce !== pending) throw Error('UNTRACKED_OWNER_TRANSACTION');
    let steps: Step[];
    if (phase === 'gas') {
      steps = [{ name: 'test-owner-gas', nonce, to: account.address, valueWei: gasFundingWei.toString(), data: '0x' }];
    } else if (phase === 'funding') {
      const id = await pc.readContract(sdk.participantId());
      if (id !== 0) throw Error('OWNER_ALREADY_REGISTERED');
      const calls = [sdk.approve(10_000000n), sdk.deposit(10_000000n), sdk.allocate(10_000000n)];
      steps = [{ name: 'test-collateral-mint', nonce, to: sdk.token, data: encodeFunctionData({ abi: artifact('TestUSDC').abi, functionName: 'mint', args: [owner, 20_000000n] }) },
        ...calls.map((call, i) => ({ name: call.functionName, nonce: nonce + i + 1, to: transactionData(call).to, data: transactionData(call).data }))];
    } else {
      let call;
      if (phase === 'release') call = sdk.release(1_000000n);
      else if (phase === 'withdraw') call = sdk.withdraw(1_000000n);
      else {
        const [risk, id, bba] = await Promise.all([
          pc.readContract({ address: sdk.market.engine, abi, functionName: 'marketRiskView', blockNumber: block.number }),
          pc.readContract({ ...sdk.participantId(), blockNumber: block.number }),
          pc.readContract({ address: sdk.market.engine, abi, functionName: 'bestBidAsk', blockNumber: block.number }),
        ]) as any[];
        if (!risk.indexAvailable || risk.accountingState !== 0 || !id) throw Error('WAIT_FOR_LIVE_INDEX');
        const position = await pc.readContract({ address: sdk.market.engine, abi, functionName: 'previewAccount', args: [id], blockNumber: block.number }) as any;
        if (phase === 'buy' ? position.positionLots !== 0n : position.positionLots !== 10_000n) throw Error('UNEXPECTED_OWNER_POSITION');
        const order = { kind: 1, isBuy: phase === 'buy', reduceOnly: phase === 'close', tick: Number(bba[phase === 'buy' ? 1 : 0]), size: 10_000n, maxFills: 8, expiryBlock: 0 };
        const preview = await pc.readContract({ ...sdk.previewOrder(id, order), blockNumber: block.number });
        if (preview.rejection || preview.acceptedCapLots < order.size) throw Error('ORDER_NOT_ADMITTED');
        call = sdk.placeOrder(order);
      }
      const tx = transactionData(call);
      steps = [{ name: phase, nonce, to: tx.to, data: tx.data }];
    }
    if ((await pc.getBlock({ blockNumber: block.number })).hash !== block.hash) throw Error('READ_BLOCK_CHANGED');
    atomicWrite(file, { ...base, preparedBlock: block.number.toString(), preparedBlockHash: block.hash,
      deployer: owner, startNonce: nonce, maxTotalGasCostWei: (phase === 'gas' ? gasFundingWei + parseEther('0.05') : parseEther('0.35')).toString(), steps });
    console.log(JSON.stringify({ prepared: phase, owner, engine: sdk.market.engine, transactions: steps.length }));
  } else {
    const plan = read(file) as Plan;
    let executionDirectory = root;
    if (command === 'broadcast') {
      const proofFile = `${root}/${phase}-rehearsal-proof.json`;
      const proof = existsSync(proofFile) ? read(proofFile) : null;
      if (proof && (typeof proof.directory !== 'string' || !new RegExp(`^${root}/rehearsals/${phase}-[0-9]+$`).test(proof.directory))) throw Error('INVALID_REHEARSAL_PROOF');
      const rehearsal = read(`${proof?.directory ?? root}/${phase}-rehearsal-journal.json`);
      if (rehearsal.status !== 'passed' || rehearsal.planHash !== keccak256(stringToHex(json(plan)))) throw Error('MATCHING_REHEARSAL_REQUIRED');
      if (['buy', 'close', 'release'].includes(phase)) {
        // Releases also require an available independent index. A flat position
        // alone does not bypass the engine's release eligibility checks.
        const deadline = Date.now() + (phase === 'release' ? 900_000 : 180_000);
        let fresh = false;
        while (Date.now() < deadline) {
          const head = await pc.getBlock({ blockTag: 'finalized' });
          const [risk, source] = await Promise.all([
            pc.readContract({ address: sdk.market.engine, abi, functionName: 'marketRiskView', blockNumber: head.number }),
            pc.readContract({ address: sdk.market.engine, abi, functionName: 'sourceState', args: [sdk.market.sourceId], blockNumber: head.number }),
          ]) as any[];
          let releaseEligible = true;
          if (phase === 'release') {
            const id = await pc.readContract({ ...sdk.participantId(), blockNumber: head.number });
            const preview = id ? await pc.readContract({ address: sdk.market.engine, abi, functionName: 'previewAccount', args: [id], blockNumber: head.number }) as any : null;
            releaseEligible = !!preview && preview.usableReleaseAtoms >= 1_000000n;
          }
          if (risk.indexAvailable && risk.accountingState === 0 && releaseEligible && head.timestamp >= source.lastObservedAt
            && head.timestamp - source.lastObservedAt <= 12n && (await pc.getBlock({ blockNumber: head.number })).hash === head.hash) { fresh = true; break; }
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
        if (!fresh) throw Error('WAIT_FOR_LIVE_INDEX');
      }
    } else {
      // Each replay has its own evidence directory. Failed or partially completed
      // attempts remain intact when a newer public block is rehearsed.
      executionDirectory = `${root}/rehearsals/${phase}-${Date.now()}`;
      mkdirSync(executionDirectory, { recursive: true, mode: 0o700 });
      const fork = client(rehearsalRpc!).public;
      const url = new URL(rehearsalRpc!);
      if (url.protocol !== 'http:' || !['localhost', '127.0.0.1'].includes(url.hostname)
        || !String(await fork.request({ method: 'web3_clientVersion' })).toLowerCase().includes('anvil')) throw Error('REHEARSAL_ANVIL_REQUIRED');
      // Remote fork storage reads can take longer than the 30-second lifetime.
      // Replay at the captured chain time, advancing one second per mined block.
      await fork.request({ method: 'anvil_setBlockTimestampInterval', params: [1] } as never);
    }
    await executePlan(plan, executionDirectory, command === 'broadcast' ? rpc : rehearsalRpc!, command === 'broadcast', phase, async (_p, chain, journal) => {
      const anchor = await chain.getBlock({ blockTag: journal.broadcast ? 'finalized' : 'latest' });
      const id = await chain.readContract({ ...sdk.participantId(), blockNumber: anchor.number });
      const position = id ? await chain.readContract({ address: sdk.market.engine, abi, functionName: 'previewAccount', args: [id], blockNumber: anchor.number }) as any : null;
      const [free, balance, gasBalance] = await Promise.all([
        chain.readContract({ ...sdk.freeBalance(), blockNumber: anchor.number }),
        chain.readContract({ ...sdk.walletBalance(), blockNumber: anchor.number }),
        chain.getBalance({ address: account.address, blockNumber: anchor.number }),
      ]);
      const fills = parseEventLogs({ abi, eventName: 'Fill', logs: journal.steps.at(-1).receipt.logs.filter((log: { address: string }) => log.address.toLowerCase() === sdk.market.engine.toLowerCase()) }) as any[];
      if (phase === 'gas') {
        const transfer = plan.steps[0];
        if (plan.steps.length !== 1 || transfer.to?.toLowerCase() !== account.address.toLowerCase()
          || transfer.data !== '0x' || !transfer.valueWei || BigInt(transfer.valueWei) < parseEther('0.6')
          || BigInt(transfer.valueWei) > parseEther('3') || gasBalance < BigInt(transfer.valueWei)) throw Error('GAS_FUNDING_FAILED');
      }
      if (phase === 'funding' && (!id || position.cashQ !== 10n * 10n ** 24n || free !== 0n || balance !== 10_000000n)) throw Error('CUSTODY_SEQUENCE_FAILED');
      if (['buy', 'close'].includes(phase) && (fills.length === 0 || fills.reduce((sum, e) => sum + e.args.size, 0n) !== 10_000n
        || position.positionLots !== (phase === 'buy' ? 10_000n : 0n))) throw Error('EXACT_FILL_NOT_CONFIRMED');
      if (phase === 'release' && free !== 1_000000n) throw Error('RELEASE_FAILED');
      if (phase === 'withdraw' && (free !== 0n || balance !== 11_000000n)) throw Error('WITHDRAWAL_FAILED');
      if ((await chain.getBlock({ blockNumber: anchor.number })).hash !== anchor.hash) throw Error('READ_BLOCK_CHANGED');
      return { passed: true, phase, owner: account.address, engine: sdk.market.engine, block: anchor.number, blockHash: anchor.hash, position, free, wallet: balance,
        fills: fills.map(f => ({ ...f.args })), hashes: journal.steps.map((s: { hash: Hex }) => s.hash), scope: journal.broadcast ? 'real testnet owner flow' : 'fork rehearsal; not a public trade' };
    }, phase === 'gas' ? undefined : account);
    if (command === 'rehearse') atomicWrite(`${root}/${phase}-rehearsal-proof.json`, { directory: executionDirectory });
  }
} catch (error) {
  const reason = (error as Error).message.match(/^[A-Z_]+$/)?.[0] ?? 'LIVE_TRADER_PROOF_FAILED';
  const causes: string[] = [];
  let cause = error as { name?: string; cause?: unknown; data?: { errorName?: string } } | undefined;
  for (let i = 0; cause && i < 8; i++, cause = cause.cause as typeof cause) {
    if (cause.name && /^[A-Za-z]+$/.test(cause.name)) causes.push(cause.name);
    if (cause.data?.errorName && /^[A-Za-z]+$/.test(cause.data.errorName)) causes.push(cause.data.errorName);
  }
  // Provider messages may include credential-bearing URLs. Expose class names only.
  console.error(JSON.stringify({ reason, phase, command, causes }));
  process.exitCode = 1;
}
