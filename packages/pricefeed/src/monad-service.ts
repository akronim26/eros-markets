import { existsSync, lstatSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { isAddress } from 'viem';
import { parseConfig, type MarketConfig } from './config.js';
import { parseRules, rulesHash, type RulesManifest } from './rules.js';
import { uint } from './math.js';
import type { RelayPolicy } from './durable-relay.js';
import { MonadTestnetPipeline, MonadTestnetRelay, type TestnetRelayBudget } from './monad-pipeline.js';
import { MonadTestnetObservationSigner, MonadTestnetTransactionSigner } from './monad-signers.js';
import { monadRpcTransport, monadSubmissionRpc } from './monad-rpc.js';
import { monadTestnetReadRpc, parseEngineReadAbi, preflightMonadTestnet } from './monad-preflight.js';
import { monadLifecycleReader } from './monad-lifecycle.js';
import { MonadTestnetPublicationLifecycle, validateMonadLifecycleConfig } from './lifecycle.js';
import { Journal } from './journal.js';
import { PacketStore, type PacketDomain } from './packet-store.js';
import { Worker } from './worker.js';
import { PublicPolymarket, RequestLimiter } from './polymarket.js';
import type { PipelineResult } from './pipeline.js';
import { record } from './book.js';

export type TestnetRunPolicy={sender:string;relay:RelayPolicy;budget:TestnetRelayBudget};
export function parseTestnetRunPolicy(value:unknown):TestnetRunPolicy {
  const p=record(value),r=record(p.relay),b=record(p.budget);
  if(p.schemaVersion!=='1'||typeof p.sender!=='string'||!isAddress(p.sender)||/^0x0{40}$/i.test(p.sender))throw new Error('BAD_TESTNET_RUN_POLICY');
  const amount=(name:string)=>uint(r[name],256);
  const number=(v:unknown,min:number,max:number)=>{
    if(typeof v!=='number'||!Number.isSafeInteger(v)||v<min||v>max)throw new Error('BAD_TESTNET_RUN_POLICY');return v;
  };
  const relay:RelayPolicy={gasCap:amount('gasCap'),maxFeePerGas:amount('maxFeePerGas'),maxPriorityFeePerGas:amount('maxPriorityFeePerGas'),
    maxCostWei:amount('maxCostWei'),headroomMs:amount('headroomMs'),confirmations:amount('confirmations'),
    leaseMs:amount('leaseMs'),timeoutMs:number(r.timeoutMs,1,30000),maxAttempts:number(r.maxAttempts,1,10),
    ...(r.gasSafetyMarginBps!==undefined?{gasSafetyMarginBps:amount('gasSafetyMarginBps')}:{})};
  const budget={maxTransactions:number(b.maxTransactions,1,100000),totalMaxCostWei:uint(b.totalMaxCostWei,256)};
  if(relay.gasCap<=0n||relay.maxFeePerGas<=0n||relay.maxPriorityFeePerGas>relay.maxFeePerGas
    ||relay.maxCostWei<relay.gasCap*relay.maxFeePerGas||relay.headroomMs<=0n||relay.headroomMs>30000n
    ||relay.confirmations!==1n||relay.leaseMs<BigInt(relay.timeoutMs)*8n||relay.leaseMs>3600000n
    ||budget.totalMaxCostWei<relay.maxCostWei
    ||relay.gasSafetyMarginBps!==undefined&&(relay.gasSafetyMarginBps<100n||relay.gasSafetyMarginBps>5000n))throw new Error('BAD_TESTNET_RUN_POLICY');
  return {sender:p.sender,relay,budget};
}
export type TestnetServiceOptions={config:MarketConfig;rules:RulesManifest;abi:unknown;rpcUrl:string;
  keysDirectory:string;journalDirectory:string;policy:TestnetRunPolicy;durationSeconds:number;stopAfterFinalized:number;initialize:boolean};
/** Finite explicitly budgeted testnet service, with five durable journals and no production admission. */
export async function runMonadTestnetService(options:TestnetServiceOptions,signal:AbortSignal,
  onResult:(result:PipelineResult)=>void|Promise<void>):Promise<Record<string,unknown>> {
  const cfg=validateMonadLifecycleConfig(parseConfig(structuredClone(options.config))),d=cfg.destination!;
  const rules=parseRules(structuredClone(options.rules)),parsed=parseEngineReadAbi(options.abi),policy=structuredClone(options.policy);
  if(parsed.abiHash.toLowerCase()!==d.abiHash.toLowerCase()||rulesHash(rules)!==d.sourceRulesHash.toLowerCase())throw new Error('MONAD_CONFIG_OR_ABI_MISMATCH');
  if(!Number.isSafeInteger(options.durationSeconds)||options.durationSeconds<1||options.durationSeconds>86400
    ||!Number.isSafeInteger(options.stopAfterFinalized)||options.stopAfterFinalized<1
    ||options.stopAfterFinalized>policy.budget.maxTransactions)throw new Error('BAD_TESTNET_RUN_LIMIT');
  const root=options.journalDirectory;
  if(!existsSync(root)){
    if(!options.initialize)throw new Error('TESTNET_JOURNALS_MISSING');
    mkdirSync(root,{recursive:true,mode:0o700});
  }
  const stat=lstatSync(root);
  if(!stat.isDirectory()||stat.isSymbolicLink()||(stat.mode&0o077)!==0||stat.uid!==process.getuid?.())throw new Error('TESTNET_PRIVATE_DIRECTORY_REQUIRED');
  const files=['source.sqlite','packets.sqlite','signer.sqlite','transactions.sqlite','relay.sqlite'];
  if(options.initialize?files.some(f=>existsSync(join(root,f))):files.some(f=>!existsSync(join(root,f))))throw new Error('TESTNET_JOURNAL_SET_INCOMPLETE_OR_ALREADY_EXISTS');
  const read=monadTestnetReadRpc(options.rpcUrl);
  await preflightMonadTestnet(read,{config:cfg,abi:parsed.abi});
  const keys=options.keysDirectory,domain:PacketDomain={chainId:10143n,engine:d.engineAddress,marketId:d.marketId,
    sourceId:d.sourceId,rulesHash:d.sourceRulesHash,signer:d.signerAddress};
  // Unlock and check identities before creating the journal set.
  const {loadTestnetKey}=await import('./monad-keys.js');
  loadTestnetKey(join(keys,'observation-signer.json'),join(keys,'signer-password'),d.signerAddress);
  loadTestnetKey(join(keys,'transaction-signer.json'),join(keys,'transaction-password'),policy.sender);
  const source=new Journal(join(root,'source.sqlite')),packets=new PacketStore(join(root,'packets.sqlite'));
  let signer:MonadTestnetObservationSigner|undefined,transactionSigner:MonadTestnetTransactionSigner|undefined,
    relay:MonadTestnetRelay|undefined,pipeline:MonadTestnetPipeline|undefined;
  const stop=new AbortController(),forward=()=>stop.abort();signal.addEventListener('abort',forward,{once:true});
  if(signal.aborted)forward();let timer:ReturnType<typeof setTimeout>|undefined;
  try{
    if(!source.verify()||!packets.verify())throw new Error('TESTNET_JOURNAL_INTEGRITY');
    signer=new MonadTestnetObservationSigner(join(root,'signer.sqlite'),domain,packets,()=>BigInt(Date.now()),
      join(keys,'observation-signer.json'),join(keys,'signer-password'));
    transactionSigner=new MonadTestnetTransactionSigner(join(root,'transactions.sqlite'),cfg,
      join(keys,'transaction-signer.json'),join(keys,'transaction-password'),policy.sender,policy.relay,options.initialize);
    const transport=monadRpcTransport(options.rpcUrl,cfg,parsed.abi,transactionSigner,policy.relay,monadSubmissionRpc(options.rpcUrl));
    relay=new MonadTestnetRelay(join(root,'relay.sqlite'),packets,transport,policy.relay,policy.budget);
    const worker=new Worker(cfg,new PublicPolymarket(cfg.poll,new RequestLimiter(100,200)),source,randomUUID());
    const lifecycle=new MonadTestnetPublicationLifecycle(cfg,source,randomUUID(),monadLifecycleReader(read,cfg,parsed.abi),30000n);
    pipeline=new MonadTestnetPipeline([{worker,rules,signer,lifecycle}],packets,relay,transport,policy.relay);
    await pipeline.start();
    const inventory=()=>packets.list(domain).map(p=>({packet:p.packet,digest:p.digest,signature:p.signature,state:p.state,
      delivery:relay!.get(domain,p.packet.observation.sequence)}));
    const finalized=()=>inventory().filter(p=>p.delivery?.state==='FINALIZED').length;
    timer=setTimeout(()=>stop.abort(),options.durationSeconds*1000);
    if(finalized()>=options.stopAfterFinalized)stop.abort();
    await pipeline.run(stop.signal,async(result)=>{
      await onResult(result);if(finalized()>=options.stopAfterFinalized)stop.abort();
    });
    return {mode:'MONAD_TESTNET_DIAGNOSTIC_PUBLICATION',completed:true,engine:d.engineAddress,
      finalizedPackets:finalized(),stopAfterFinalized:options.stopAfterFinalized,packets:inventory(),
      evidenceValid:source.verify()&&packets.verify(),humanGatesAccepted:false,productionApproved:false};
  }finally{
    if(timer)clearTimeout(timer);signal.removeEventListener('abort',forward);
    try{pipeline?.close();}finally{relay?.close();transactionSigner?.close();signer?.close();packets.close();source.close();}
  }
}
