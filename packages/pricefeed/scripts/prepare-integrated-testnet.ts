/** Build fresh testnet service pins and encrypted local custody from verified deployment evidence. */
import { readFileSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseEnv } from 'node:util';
import type { Hex } from 'viem';
import { createTestnetKey } from '../src/monad-keys.js';
import { parseEngineReadAbi, preflightMonadTestnet, monadTestnetReadRpc } from '../src/monad-preflight.js';
import { parseConfig } from '../src/config.js';
import { parseTestnetRunPolicy } from '../src/monad-service.js';
const [evidencePath, custodyPath, rolesPath] = process.argv.slice(2);
if (!evidencePath || !custodyPath || !rolesPath) throw new Error('EVIDENCE_CUSTODY_ROLES_PATHS_REQUIRED');
const directory=resolve(evidencePath), custody=resolve(custodyPath);
const read=(p:string)=>JSON.parse(readFileSync(p,'utf8'));
const report=read(resolve(directory,'market-verification.json')), source=read(resolve(directory,'source.json'));
if(!report.passed||report.publicTransactions!==7||report.manifest.chainId!==10143)throw new Error('VERIFIED_PUBLIC_DEPLOYMENT_REQUIRED');
const {manifest,listing}=report,m=manifest.markets[0],c=manifest.contracts;
const abi=read(resolve(import.meta.dirname,'../../../../oracle/out/RegistryBookRiskEngine.sol/RegistryBookRiskEngine.json')).abi;
const parsed=parseEngineReadAbi(abi);
const config=parseConfig({...source.config,enabled:false,destination:{chainId:'10143',engineAddress:m.engine,engineCodeHash:m.codehash,
  abiHash:parsed.abiHash,marketId:m.marketId,sourceId:m.sourceId,sourceRulesHash:source.sourceRulesHash,signerAddress:source.indexSigner,
  listedAt:listing.listedAt,scheduledT:listing.scheduledT,invalidRule:listing.invalidRule}});
const preflight=await preflightMonadTestnet(monadTestnetReadRpc('https://testnet-rpc.monad.xyz'),{config,abi});
const roles=parseEnv(readFileSync(resolve(rolesPath),'utf8'));
mkdirSync(custody,{recursive:true,mode:0o700});
const keys=resolve(custody,'keys');mkdirSync(keys,{recursive:true,mode:0o700});
if(!existsSync(resolve(keys,'observation-signer.json')))createTestnetKey(resolve(keys,'observation-signer.json'),resolve(keys,'signer-password'),roles.INDEX_SIGNER_PRIVATE_KEY as Hex);
const {loadTestnetKey}=await import('../src/monad-keys.js');
loadTestnetKey(resolve(keys,'observation-signer.json'),resolve(keys,'signer-password'),source.indexSigner);
// Separate gas-paying account; the price signing key holds no MON.
const {privateKeyToAccount}=await import('viem/accounts');
const publisher=privateKeyToAccount(roles.PUBLISHER_PRIVATE_KEY as Hex).address;
if(!existsSync(resolve(keys,'transaction-signer.json')))createTestnetKey(resolve(keys,'transaction-signer.json'),resolve(keys,'transaction-password'),roles.PUBLISHER_PRIVATE_KEY as Hex);
loadTestnetKey(resolve(keys,'transaction-signer.json'),resolve(keys,'transaction-password'),publisher);
const policy={schemaVersion:'1',sender:publisher,relay:{gasCap:'800000',maxFeePerGas:'150000000000',maxPriorityFeePerGas:'2000000000',
 maxCostWei:'120000000000000000',headroomMs:'5000',confirmations:'1',leaseMs:'120000',timeoutMs:10000,maxAttempts:3,gasSafetyMarginBps:'1000'},
 budget:{maxTransactions:12,totalMaxCostWei:'1440000000000000000'}};
parseTestnetRunPolicy(policy);
const out=resolve(directory,'services');mkdirSync(out,{recursive:true});
const write=(name:string,value:unknown)=>writeFileSync(resolve(out,name),JSON.stringify(value,(_,v)=>typeof v==='bigint'?v.toString():v,2)+'\n');
write('pricefeed-config.json',config);write('pricefeed-rules.json',source.rules);write('engine-abi.json',abi);write('pricefeed-policy.json',policy);write('pricefeed-preflight.json',preflight);
write('engine-identities.json',{version:1,chainId:10143,registry:c.MarketRegistry.address,profiles:[{kind:'book-risk',runtimeCodehash:m.codehash}]});
console.log(JSON.stringify({passed:true,engine:m.engine,publisher,maximumPublicationTransactions:12,maximumPublicationCostMON:1.44,hosting:'not started'}));
