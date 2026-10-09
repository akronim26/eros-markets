/** Runs the real keeper planners against the public deployment; writes are explicitly disabled. */
import { readFileSync, appendFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { viemChain } from '../../oracle/services/keeper/src/chain';
import { Keeper } from '../../oracle/services/keeper/src/keeper';
import { planners } from '../../oracle/services/keeper/src/jobs';
import { loadEngineIdentities } from '../../oracle/services/keeper/src/engineIdentity';
const require = createRequire(new URL('../../oracle/services/keeper/package.json', import.meta.url));
const { generatePrivateKey } = require('viem/accounts');
const [directory, publicDirectory] = process.argv.slice(2);
if (!directory || !directory.startsWith('tmp/')) throw new Error('Provide an ignored tmp evidence directory');
if (!publicDirectory) throw new Error('Provide the selected public deployment directory as the second argument');
const base = join(publicDirectory, 'services');
const deployments = JSON.parse(readFileSync(join(base, 'oracle-deployments.json'), 'utf8'));
const manifest = JSON.parse(readFileSync(join(publicDirectory, 'public-manifest.json'), 'utf8'));
const current = JSON.parse(readFileSync('frontend/src/config/public-manifest.json', 'utf8'));
if (manifest.chainId !== 10143 || current.chainId !== manifest.chainId || deployments.chainId !== manifest.chainId
  || !manifest.markets.length || manifest.markets.some((market: { engine: string; marketId: string; codehash: string }) =>
    !current.markets.some((selected: typeof market) => selected.engine.toLowerCase() === market.engine.toLowerCase()
      && selected.marketId === market.marketId && selected.codehash === market.codehash))) {
  throw new Error('Observer deployment must match the current frontend market selection');
}
for (const [name, contract] of Object.entries(manifest.contracts) as [string, { address: string; codehash: string }][]) {
  for (const candidate of [current.contracts[name], deployments.contracts[name]]) {
    if (candidate?.address?.toLowerCase() !== contract.address.toLowerCase() || candidate.codehash !== contract.codehash) {
      throw new Error(`Observer contract binding mismatch: ${name}`);
    }
  }
}
const engineIdentities = loadEngineIdentities(join(base, 'engine-identities.json'), { chainId: 10143, registry: deployments.contracts.MarketRegistry.address });
const chain = viemChain({ rpcUrl: 'https://testnet-rpc.monad.xyz', privateKey: generatePrivateKey(), deployments, engineIdentities });
chain.send = async () => { throw new Error('Observer cannot broadcast'); };
let stopped = false;process.on('SIGINT', () => {stopped=true});process.on('SIGTERM', () => {stopped=true});
const log = (event: string, data: object = {}) => { const line=JSON.stringify({at:new Date().toISOString(),event,...data},(_,v)=>typeof v==='bigint'?v.toString():v);appendFileSync(directory+'/keeper.jsonl',line+'\n');console.log(line); };
const keeper = new Keeper({chain,source:{marketIds:async()=>manifest.markets.map((m: {marketId: string})=>m.marketId)},planners:planners(),gas:{},concurrency:1,
 log:{info:log,warn:log,error:log}});
log('started', {pid:process.pid,mode:'read-only real keeper planners; public broadcasts disabled'});
while(!stopped){try{log('tick',await keeper.tick());}catch(error){log('error',{message:(error as Error).message});}await new Promise(r=>setTimeout(r,30000));}
