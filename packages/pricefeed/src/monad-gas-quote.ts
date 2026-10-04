import { existsSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import type { Hex } from 'viem';
import { parseConfig, type MarketConfig } from './config.js';
import { parseRules, rulesHash, type RulesManifest } from './rules.js';
import { validateMonadLifecycleConfig } from './lifecycle.js';
import { preflightMonadTestnet, parseEngineReadAbi } from './monad-preflight.js';
import { monadSubmissionRpc, type MonadSubmissionRpc } from './monad-rpc.js';
import { PacketStore, type PacketDomain } from './packet-store.js';
import { Journal } from './journal.js';
import { MonadTestnetObservationSigner } from './monad-signers.js';
import { prepareMonadTestnetObservation, signMonadTestnetPrepared } from './publication.js';
import { submitCalldata } from './wire.js';
import { Worker, type Provider } from './worker.js';
import { PublicPolymarket, RequestLimiter } from './polymarket.js';
import { sizeGas } from './gas.js';
import { sourceTime } from './time.js';
import type { TestnetRunPolicy } from './monad-service.js';

export type GasQuoteOptions={config:MarketConfig;rules:RulesManifest;abi:unknown;rpcUrl:string;
  keysDirectory:string;journalDirectory:string;policy:TestnetRunPolicy};
/** Signs one durable quote-only observation, simulates it, then expires it; never prepares/sends a transaction. */
export async function quoteMonadGas(options:GasQuoteOptions,
  rpc:MonadSubmissionRpc=monadSubmissionRpc(options.rpcUrl),provider?:Provider,now:()=>bigint=()=>BigInt(Date.now())){
  const cfg=validateMonadLifecycleConfig(parseConfig(structuredClone(options.config))),d=cfg.destination!;
  const rules=parseRules(structuredClone(options.rules)),parsed=parseEngineReadAbi(options.abi),policy=structuredClone(options.policy);
  if(policy.relay.gasSafetyMarginBps===undefined)throw new Error('GAS_QUOTE_MARGIN_REQUIRED');
  if(rulesHash(rules)!==d.sourceRulesHash.toLowerCase()||parsed.abiHash.toLowerCase()!==d.abiHash.toLowerCase())throw new Error('MONAD_CONFIG_OR_ABI_MISMATCH');
  const stat=lstatSync(options.journalDirectory);
  if(!stat.isDirectory()||stat.isSymbolicLink()||(stat.mode&0o077)!==0||stat.uid!==process.getuid?.())throw new Error('TESTNET_PRIVATE_DIRECTORY_REQUIRED');
  const root=options.journalDirectory,owner=randomUUID(),domain:PacketDomain={chainId:10143n,engine:d.engineAddress,
    marketId:d.marketId,sourceId:d.sourceId,rulesHash:d.sourceRulesHash,signer:d.signerAddress};
  if(['source','packets','signer','transactions','relay'].some(name=>!existsSync(join(root,name+'.sqlite'))))throw new Error('TESTNET_JOURNAL_SET_INCOMPLETE_OR_ALREADY_EXISTS');
  const checkpoint=await preflightMonadTestnet(rpc,{config:cfg,abi:parsed.abi},now);
  const relay=new DatabaseSync(join(root,'relay.sqlite'),{readOnly:true});
  let delivered:Set<string>;
  try{
    const accounts=relay.prepare('SELECT sender,until_ms FROM relay_nonce').all();
    if(accounts.length!==1||accounts[0]!.sender!==policy.sender.toLowerCase()||BigInt(String(accounts[0]!.until_ms))>now())throw new Error('GAS_QUOTE_IDLE_RELAY_REQUIRED');
    if(relay.prepare('SELECT reason FROM relay_control WHERE id=1').get()?.reason)throw new Error('RELAY_PERSISTENT_QUARANTINE');
    delivered=new Set(relay.prepare('SELECT body,sha256 FROM deliveries').all().map(row=>{
      const body=String(row.body);if(createHash('sha256').update(body).digest('hex')!==row.sha256)throw new Error('DELIVERY_JOURNAL_INTEGRITY');
      const delivery=JSON.parse(body);
      if(delivery.state!=='FINALIZED'||BigInt(delivery.sequence)>checkpoint.engine!.sourceState.lastSequence)throw new Error('GAS_QUOTE_FINALIZED_HISTORY_REQUIRED');
      return String(delivery.sequence);
    }));
  }finally{relay.close();}
  const packets=new PacketStore(join(root,'packets.sqlite')),source=new Journal(join(root,'source.sqlite'));
  let signer:MonadTestnetObservationSigner|undefined,worker:Worker|undefined,fence=0n,sequence:bigint|undefined;
  try{
    const nonceBefore=await rpc.nonce(policy.sender as Hex);
    if(!source.verify()||!packets.verify())throw new Error('TESTNET_JOURNAL_INTEGRITY');
    fence=packets.acquire(domain,owner,now(),120000n);
    signer=new MonadTestnetObservationSigner(join(root,'signer.sqlite'),domain,packets,now,
      join(options.keysDirectory,'observation-signer.json'),join(options.keysDirectory,'signer-password'));
    signer.reconcile(owner,fence,checkpoint.engine!.sourceState);
    if(packets.list(domain).some(p=>p.state!=='EXPIRED'&&!delivered.has(p.packet.observation.sequence.toString())))throw new Error('GAS_QUOTE_UNRESOLVED_PACKET');
    worker=new Worker(cfg,provider??new PublicPolymarket(cfg.poll,new RequestLimiter(100,200)),source,owner,now);
    const result=await worker.poll();
    if(!result.book||!result.metadata||!result.event||!['COLLECTING','INVALID_DEPTH'].includes(result.inspection.status))throw new Error('GAS_QUOTE_SOURCE_UNAVAILABLE');
    const packet=packets.allocate(domain,owner,fence,now(),seq=>prepareMonadTestnetObservation(cfg,rules,
      {bookBody:result.book!.body,metadata:JSON.parse(result.metadata!.body),event:JSON.parse(result.event!.body),
        bookReceivedAtMs:result.book!.receivedAtMs,metadataReceivedAtMs:result.metadata!.receivedAtMs,eventReceivedAtMs:result.event!.receivedAtMs},
      seq,now(),policy.relay.headroomMs));sequence=packet.observation.sequence;
    const signed=await signMonadTestnetPrepared(packets,domain,owner,fence,sequence,signer,now,policy.relay.headroomMs);
    if(signed.state!=='SIGNED')throw new Error('GAS_QUOTE_HEADROOM_EXPIRED');
    const data=submitCalldata(packet.observation,signed.signature!);
    const estimated=await rpc.simulate(policy.sender as Hex,d.engineAddress as Hex,data,policy.relay.gasCap);
    const sizing=sizeGas(estimated,policy.relay.gasCap,policy.relay.gasSafetyMarginBps);
    const verified=await rpc.simulate(policy.sender as Hex,d.engineAddress as Hex,data,sizing.gasLimit);
    if(typeof verified!=='bigint'||verified<21000n||verified>sizing.gasLimit)throw new Error('MONAD_GAS_CAP_EXCEEDED');
    if(!sourceTime(packet.sourceMs.toString(),now(),null,policy.relay.headroomMs).hasHeadroom)throw new Error('GAS_QUOTE_HEADROOM_EXPIRED');
    const after=await preflightMonadTestnet(rpc,{config:cfg,abi:parsed.abi},now),nonceAfter=await rpc.nonce(policy.sender as Hex);
    if(after.engine!.sourceState.lastSequence!==checkpoint.engine!.sourceState.lastSequence||nonceAfter!==nonceBefore)throw new Error('GAS_QUOTE_CHAIN_CHANGED');
    return {mode:'MONAD_TESTNET_GAS_QUOTE',chainId:10143,engine:d.engineAddress,sender:policy.sender,sequence,
      packet:signed.packet,digest:signed.digest,signature:signed.signature,sizing,sourceCapture:result,
      quoteStartedAtMs:checkpoint.checkedAtMs,quoteFinishedAtMs:now(),checkpoint:after,
      nonceBefore,nonceAfter,senderBalanceWei:await rpc.balance(policy.sender as Hex),
      maxCostWei:sizing.gasLimit*policy.relay.maxFeePerGas,transactionsSent:0,transactionNoncesReserved:0,
      quotePacketExpired:true,productionApproved:false};
  }finally{
    try{if(sequence!==undefined)packets.expire(domain,owner,fence,now(),sequence,'GAS_QUOTE_ONLY_NOT_FOR_DELIVERY');}
    finally{
      try{if(fence)packets.release(domain,owner,fence);}
      finally{
        try{worker?.releaseLease();}
        finally{signer?.close();packets.close();source.close();}
      }
    }
  }
}
