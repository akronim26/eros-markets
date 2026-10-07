import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createPublicClient, createWalletClient, http, keccak256, stringToHex } from 'viem';
import { mnemonicToAccount } from 'viem/accounts';
import { anvil } from 'viem/chains';

export const root = path.resolve(import.meta.dirname, '../../..');
export const runtime = JSON.parse(fs.readFileSync(path.join(process.env.EROS_E2E_STACK, 'runtime.json'), 'utf8'));
export const manifest = JSON.parse(fs.readFileSync(process.env.EROS_E2E_MANIFEST, 'utf8'));
const endpoint = new URL(runtime.rpcUrl);
assert.equal(endpoint.protocol, 'http:'); assert.equal(endpoint.hostname, '127.0.0.1');
assert.equal(endpoint.username + endpoint.password + endpoint.search + endpoint.hash, '');
assert.equal(endpoint.pathname, '/'); assert.equal(manifest.chainId, 31337); assert.equal(manifest.scope, 'local-only');
assert.equal(runtime.status, 'passed');
export const client = createPublicClient({ chain: anvil, transport: http(endpoint.toString(), { retryCount: 0 }) });
export const demo = manifest.markets.find(m => m.name === 'demo');
assert.ok(demo);
export const token = manifest.contracts.CollateralToken.address;
export const vault = manifest.contracts.CollateralVault.address;
export const abi = (filename) => JSON.parse(fs.readFileSync(path.join(root, 'oracle/out', filename + '.sol', filename + '.json'), 'utf8')).abi;
export const engineAbi = abi('RegistryBookRiskEngine');
export const tokenAbi = abi('MockUSDC');
export const vaultAbi = abi('CollateralVault');
const mnemonic = 'test test test test test test test test test test test junk';
// Public Anvil fixture mnemonic; never read root .env or accept a caller-supplied key.
export const actor = index => mnemonicToAccount(mnemonic, { addressIndex: index });
export async function guard() {
  assert.equal(await client.getChainId(), 31337, 'Refuse to sign outside the disposable chain');
  const verified = await client.getBlock({ blockNumber: BigInt(manifest.verifiedAt.blockNumber) });
  assert.equal(verified.hash, manifest.verifiedAt.blockHash, 'Fixture was reset or manifest is stale');
  assert.equal(keccak256(await client.getCode({ address: demo.engine })), demo.codehash);
}
export const read = (functionName, args = []) => client.readContract({ address: demo.engine, abi: engineAbi, functionName, args });
export async function send(index, address, contractAbi, functionName, args = []) {
  await guard();
  const wallet = createWalletClient({ chain: anvil, transport: http(endpoint.toString()), account: actor(index) });
  const hash = await wallet.writeContract({ address, abi: contractAbi, functionName, args, gas: 8_000_000n });
  const receipt = await client.waitForTransactionReceipt({ hash });
  assert.equal(receipt.status, 'success', `${functionName} reverted`);
  fs.appendFileSync(path.join(process.env.EROS_E2E_DIRECTORY, 'fixture-transactions.jsonl'), JSON.stringify({ functionName, hash,
    blockNumber: receipt.blockNumber.toString(), blockHash: receipt.blockHash, status: receipt.status }) + '\n');
  return receipt;
}
export async function syncClock(page) {
  const block = await client.getBlock();
  await page.clock.setSystemTime(new Date(Number(block.timestamp) * 1000));
}
export async function settleDemo() {
  // Stop the publisher through its documented drain marker; preserve all journals.
  fs.writeFileSync(path.join(process.env.EROS_E2E_STACK, 'pricefeed', 'stop-watcher'), 'Browser E2E controlled fixture settlement\n');
  const publisher = runtime.processes.find(p => p.name === 'fixture-publisher');
  assert.ok(publisher, 'Expected the owned local publisher');
  const deadline = Date.now() + 40_000;
  while (true) {
    try {
      process.kill(publisher.pid, 0);
      const status = execFileSync('ps', ['-o', 'stat=', '-p', String(publisher.pid)], { encoding: 'utf8' }).trim();
      if (!status || status.startsWith('Z')) break;
    } catch (error) { if (error.code === 'ESRCH' || error.status === 1) break; throw error; }
    if (Date.now() > deadline) throw new Error('Publisher did not drain before settlement');
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  const oracle = manifest.contracts.ResolutionOracle.address, registry = manifest.contracts.MarketRegistry.address;
  const oracleAbi = abi('ResolutionOracle'), registryAbi = abi('MarketRegistry');
  const oread = (functionName, args = []) => client.readContract({ address: oracle, abi: oracleAbi, functionName, args });
  const osend = (name, args = []) => send(0, oracle, oracleAbi, name, args);
  const hash = text => keccak256(stringToHex(text));
  const uri = 'ipfs://bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi';
  await send(0, demo.engine, engineAbi, 'requestReduceOnly', [hash('LOCAL_CONTROLLED_TERMINAL_SCENARIO')]);
  await osend('requestEarlyCheck', [demo.marketId]);
  let resolution = await oread('getResolution', [demo.marketId]);
  const core = await client.readContract({ address: registry, abi: registryAbi, functionName: 'getMarketCore', args: [demo.marketId] });
  const panel = { marketId: demo.marketId, phase: 1, attempt: resolution.attempts, labels: [1, 1, 1], calibratedBps: [9500, 9500, 9500],
    evidenceHash: hash('LOCAL_SCRIPTED_EVIDENCE_NOT_MODEL_OUTPUT'), evidenceURIHash: hash(uri), gateHash: core.gateHash,
    flags: 0, trustSetId: await oread('activeTrustSetId'), deadline: (await client.getBlock()).timestamp + 3600n };
  await osend('submitPanelResult', [demo.marketId, panel, uri, await actor(5).sign({ hash: await oread('hashPanelResult', [panel]) })]);
  resolution = await oread('getResolution', [demo.marketId]);
  const proposal = { marketId: demo.marketId, outcome: 1, evidenceHash: panel.evidenceHash, evidenceURIHash: panel.evidenceURIHash,
    noteHash: hash('LOCAL_SCRIPTED_COMMITTEE_NOT_INDEPENDENT_REVIEW'), attempt: resolution.attempts, rejectedMask: resolution.rejectedMask,
    early: true, trustSetId: panel.trustSetId, deadline: panel.deadline };
  const digest = await oread('hashReviewedProposal', [proposal]);
  const committee = [6, 7, 8].map(actor).sort((a, b) => a.address.toLowerCase().localeCompare(b.address.toLowerCase())).slice(0, 2);
  const signatures = await Promise.all(committee.map(async a => ({ signer: a.address, signature: await a.sign({ hash: digest }) })));
  await osend('submitReviewedProposal', [demo.marketId, proposal, uri, signatures]);
  await osend('assertProposal', [demo.marketId]);
  resolution = await oread('getResolution', [demo.marketId]);
  const venue = manifest.contracts.MockAssertionVenue.address, venueAbi = abi('MockAssertionVenue');
  const status = await client.readContract({ address: venue, abi: venueAbi, functionName: 'statusOf', args: [resolution.assertionId] });
  await guard();
  await client.request({ method: 'evm_setNextBlockTimestamp', params: [Number(status.expiresAt) + 1] });
  await client.request({ method: 'evm_mine', params: [] });
  await send(0, venue, venueAbi, 'setResult', [resolution.assertionId, true]);
  await osend('finalizeMarket', [demo.marketId]);
  // Payout scanning and payout allocation are separate passes, even when all
  // owners fit in one chunk. Finish only after the contract reports each job done.
  for (const functionName of ['prepareSnapshotChunk', 'preparePayoutChunk']) {
    let done = false;
    for (let i = 0; i < 64 && !done; i++) {
      const preview = await client.simulateContract({ address: demo.engine, abi: engineAbi,
        functionName, args: [32], account: actor(0).address });
      await send(0, demo.engine, engineAbi, functionName, [32]);
      done = preview.result.done;
    }
    assert.equal(done, true, `${functionName} exceeded the bounded preparation limit`);
  }
  await send(0, demo.engine, engineAbi, 'finishPreparation');
  assert.equal(await read('claimsEnabled'), true);
}
