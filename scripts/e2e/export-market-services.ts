/** Export credential-free service pins only from a verified public market. */
import { readFileSync, mkdirSync, copyFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { artifact, atomicWrite, client } from '../../oracle/e2e/src/fresh-testnet';
import { manifestSchema } from '../../oracle/services/market-ops/src/schema';
import { parseConfig } from '../../packages/pricefeed/src/config';
import { parseEngineReadAbi, preflightMonadTestnet, monadTestnetReadRpc } from '../../packages/pricefeed/src/monad-preflight';
const [privateInput, publicInput] = process.argv.slice(2);
if (!privateInput?.startsWith('tmp/') || !publicInput?.startsWith('artifacts/deployments/')) throw Error('EXPLICIT_DEPLOYMENT_PATHS_REQUIRED');
const root=resolve(privateInput),out=resolve(publicInput),read=(p:string)=>JSON.parse(readFileSync(p,'utf8'));
const report=read(root+'/market-verification.json'),base=read(root+'/base-plan.json'),source=read(root+'/source.json');
if(!report.passed||report.publicTransactions!==7)throw Error('VERIFIED_PUBLIC_MARKET_REQUIRED');
const m=report.manifest.markets[0],c=report.manifest.contracts,l=report.listing;
const abi=read('artifacts/deployments/monad-testnet-20261006/services/engine-abi.json');
const config=parseConfig({...source.config,destination:{chainId:'10143',engineAddress:m.engine,engineCodeHash:m.codehash,
  abiHash:parseEngineReadAbi(abi).abiHash,marketId:m.marketId,sourceId:m.sourceId,sourceRulesHash:source.sourceRulesHash,
  signerAddress:source.indexSigner,listedAt:l.listedAt,scheduledT:l.scheduledT,invalidRule:l.invalidRule}});
const rpc=process.env.MONAD_TESTNET_RPC!;
await preflightMonadTestnet(monadTestnetReadRpc(rpc),{config,abi:parseEngineReadAbi(abi).abi});
const pc=client(rpc).public,block=await pc.getBlock({blockTag:'finalized'});
const estimate=await pc.estimateContractGas({address:m.engine,abi:artifact('RegistryBookRiskEngine').abi,functionName:'samplePerp',account:base.roles.KEEPER,blockNumber:block.number});
const sampleGas=Number(estimate*125n/100n+10000n);
const ops=manifestSchema.parse({chainId:10143,engine:m.engine,engineCodeHash:m.codehash,listingHash:m.listingHash,marketId:m.marketId,
  oracle:c.ResolutionOracle.address,oracleCodeHash:c.ResolutionOracle.codehash,sender:base.roles.KEEPER,sampleEveryBlocks:'30',
  rolloverHelper:{address:c.RolloverBatcher.address,codeHash:c.RolloverBatcher.codehash,maxPages:32,gasCeiling:30000000},gas:{samplePerp:sampleGas}});
const policy={schemaVersion:'1',sender:base.roles.PUBLISHER,
  relay:{gasCap:'800000',maxFeePerGas:'150000000000',maxPriorityFeePerGas:'2000000000',maxCostWei:'120000000000000000',headroomMs:'5000',confirmations:'1',leaseMs:'120000',timeoutMs:10000,maxAttempts:3,gasSafetyMarginBps:'1000'},
  budget:{maxTransactions:500,totalMaxCostWei:'16000000000000000000'}};
mkdirSync(out+'/services',{recursive:true});
for(const [name,value] of Object.entries({'public-manifest':report.manifest,'market-verification':report,'source':source,'calibration':read(root+'/calibration.json')}))atomicWrite(`${out}/${name}.json`,value);
for(const [name,value] of Object.entries({'pricefeed-config':config,'pricefeed-rules':source.rules,'pricefeed-policy':policy,'engine-abi':abi,'market-ops':ops,
  'engine-identities':{version:1,chainId:10143,registry:c.MarketRegistry.address,profiles:[{kind:'book-risk',runtimeCodehash:m.codehash}]}}))atomicWrite(`${out}/services/${name}.json`,value);
copyFileSync('artifacts/deployments/monad-testnet-20261006/services/oracle-deployments.json',out+'/services/oracle-deployments.json');
atomicWrite(out+'/services/market-ops-gas.json',{block:block.number,blockHash:block.hash,samplePerp:{estimate,limit:sampleGas},scope:'Remeasured dynamically with funded depth by market-services.ts.'});
console.log(JSON.stringify({exported:true,engine:m.engine,source:config.mapping.externalMarketId,sampleGas}));
