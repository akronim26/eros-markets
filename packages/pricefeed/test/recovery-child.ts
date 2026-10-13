// Dedicated child for OS-crash fixtures. SIGKILL deliberately bypasses every close/finally.
import assert from 'node:assert/strict';
import { copyFileSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { encodeAbiParameters, encodeEventTopics, decodeFunctionData, keccak256, parseAbiParameters,
  parseTransaction, stringToHex, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { Journal } from '../src/journal.js';
import { PacketStore, packetNamespace } from '../src/packet-store.js';
import { LocalTestSigner } from '../src/local-test-signer.js';
import { LocalRelay, type LocalRelayTransport, type RelayPolicy } from '../src/local-relay.js';
import { prepareObservation, signPrepared, type SnapshotEvidence } from '../src/publication.js';
import { Worker, type Provider } from '../src/worker.js';
import { json } from '../src/math.js';
import { ACCEPTED_ABI, type DeliveryReceipt } from '../src/receipts.js';
import { INGRESS_ABI, parseObservation } from '../src/wire.js';
import { config, reviewed, candidate, body, metadata, event } from './publication-fixture.js';

async function main() {
  const [dir,mode,requested]=process.argv.slice(2);if(!dir||!mode||!requested)throw new Error('FIXTURE_ARGUMENTS_REQUIRED');
  const initial=mode==='crash',owner=initial?'original':'replacement';
  let now=initial?1000100n:mode==='early'?1000200n:mode==='expired'?1040100n:1011100n,headOffset=0n;
  const path=(name:string)=>join(dir,name+'.sqlite');
  const crash=(stage:string)=>{
    if(initial&&requested===stage){writeSync(1,json({crashedAt:stage})+'\n');process.kill(process.pid,'SIGKILL');throw new Error('SIGKILL_DID_NOT_TERMINATE');}
  };
  // Short fixture request budgets give a 10,013-ms collector lease. Recovery clock
  // advances 11 seconds, rather than overriding a live writer or rewriting timestamps.
  const cfg={...config,poll:{...config.poll,intervalMs:10,timeoutMs:1,maxRetries:0,retryDelayMs:0}};
  const domain=candidate(1n).domain;
  const journal=new Journal(path('source'));
  let packets=new PacketStore(path('packets'));
  const counterpart=new DatabaseSync(path('counterpart'));
  counterpart.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
    CREATE TABLE IF NOT EXISTS tx_reservations(nonce TEXT PRIMARY KEY,request TEXT NOT NULL,raw TEXT NOT NULL) STRICT;
    CREATE TABLE IF NOT EXISTS sends(nonce TEXT PRIMARY KEY,sequence TEXT NOT NULL,raw TEXT NOT NULL,hash TEXT NOT NULL,receipt TEXT NOT NULL,accepted_at TEXT NOT NULL,calls INTEGER NOT NULL) STRICT;`);
  const sender=privateKeyToAccount(('0x'+'22'.repeat(32)) as Hex);
  const chainState=()=>{
    const rows=counterpart.prepare('SELECT sequence,receipt FROM sends').all();
    const high=rows.reduce((n,r)=>BigInt(String(r.sequence))>n?BigInt(String(r.sequence)):n,0n);
    return {lastSequence:high,lastObservedAt:high===0n?0n:packets.get(domain,high)!.packet.observation.observedAt};
  };
  const transport:LocalRelayTransport={rpcUrl:'http://127.0.0.1:8545',sender:sender.address,
    pendingNonce:async()=>counterpart.prepare('SELECT nonce FROM sends').all().reduce((n,r)=>BigInt(String(r.nonce))>=n?BigInt(String(r.nonce))+1n:n,0n),
    identity:async()=>({chainId:31337n,engineCodeHash:cfg.destination!.engineCodeHash,abiHash:cfg.destination!.abiHash,
      signer:domain.signer,rulesHash:domain.rulesHash,...chainState(),listing:{...cfg.destination,
        indexSourceId:domain.sourceId,indexSigner:domain.signer,indexRulesHash:domain.rulesHash,
        depthNLots:cfg.pricing.depthNLots,maxSpreadWad:cfg.pricing.maxSpreadWad}}),
    simulate:async()=>{},
    prepare:async request=>{
      crash('PREPARING');
      const serialized=json(request),cached=counterpart.prepare('SELECT * FROM tx_reservations WHERE nonce=?').get(request.nonce.toString());
      if(cached){assert.equal(cached.request,serialized,'FIXTURE_TX_NONCE_IDENTITY_CONFLICT');return cached.raw as Hex;}
      const raw=await sender.signTransaction({type:'eip1559',chainId:31337,to:request.to as Hex,data:request.data,
        nonce:Number(request.nonce),gas:request.gas,maxFeePerGas:request.maxFeePerGas,maxPriorityFeePerGas:request.maxPriorityFeePerGas,value:0n});
      counterpart.prepare('INSERT INTO tx_reservations VALUES(?,?,?)').run(request.nonce.toString(),serialized,raw);
      crash('TX_SIGNED');return raw;
    },
    broadcast:async raw=>{
      crash('UNKNOWN');
      const tx=parseTransaction(raw),nonce=String(tx.nonce);
      assert.equal(counterpart.prepare('SELECT raw FROM tx_reservations WHERE nonce=?').get(nonce)!.raw,raw);
      const decoded=decodeFunctionData({abi:INGRESS_ABI,data:tx.data!}),o=parseObservation(JSON.parse(json(decoded.args[0])));
      const hash=keccak256(raw),number=10n+BigInt(nonce),blockHash=keccak256(stringToHex(`fixture-block:${number}`));
      const digest=packets.get(domain,o.sequence)!.digest,acceptedAt=now/1000n;
      const receipt:DeliveryReceipt={status:'success',transactionHash:hash,blockNumber:number,blockHash,logs:[{
        address:domain.engine,transactionHash:hash,blockNumber:number,blockHash,logIndex:0,removed:false,
        topics:encodeEventTopics({abi:ACCEPTED_ABI,eventName:'ObservationAccepted',args:{sourceId:o.sourceId as Hex}}) as Hex[],
        data:encodeAbiParameters(parseAbiParameters('uint64,uint64,uint64,uint64,uint256,bool,bytes32'),
          [o.sequence,o.observedAt,o.publishedAt,acceptedAt,o.priceWad,true,digest])}]};
      counterpart.prepare('INSERT INTO sends VALUES(?,?,?,?,?,?,1) ON CONFLICT(nonce) DO UPDATE SET calls=calls+1')
        .run(nonce,o.sequence.toString(),raw,hash,json(receipt),acceptedAt.toString());
      crash('BROADCAST');return hash;
    },
    receipt:async hash=>{
      const row=counterpart.prepare('SELECT receipt FROM sends WHERE hash=?').get(hash);
      return row?JSON.parse(String(row.receipt),(key,value)=>key==='blockNumber'?BigInt(value):value) as DeliveryReceipt:null;
    },
    block:async number=>{
      const row=counterpart.prepare('SELECT accepted_at FROM sends WHERE nonce=?').get((number-10n).toString());
      return row?{number,hash:keccak256(stringToHex(`fixture-block:${number}`)),timestamp:BigInt(String(row.accepted_at))}:null;
    },
    head:async()=>counterpart.prepare('SELECT nonce FROM sends').all().reduce((n,r)=>10n+BigInt(String(r.nonce))>n?10n+BigInt(String(r.nonce)):n,0n)+headOffset,
  };
  const policy:RelayPolicy={gasCap:100000n,maxFeePerGas:100n,maxPriorityFeePerGas:1n,maxCostWei:10000000n,
    headroomMs:1000n,confirmations:2n,timeoutMs:100,leaseMs:1000n,maxAttempts:3};
  let relay=new LocalRelay(path('relay'),packets,transport,policy,()=>now);
  if(initial){
    packets.acquire(domain,owner,now,1000n);packets.close();copyFileSync(path('packets'),path('old-packets'));
    packets=new PacketStore(path('packets'));relay.close();relay=new LocalRelay(path('relay'),packets,transport,policy,()=>now);
    await relay.start();relay.release();relay.close();copyFileSync(path('relay'),path('old-relay'));
    relay=new LocalRelay(path('relay'),packets,transport,policy,()=>now);await relay.start();
  }
  let backend:LocalTestSigner|undefined;
  try{
    if(mode==='restore-packets'){
      packets.close();copyFileSync(path('old-packets'),path('restored-packets'));packets=new PacketStore(path('restored-packets'));
      const fence=packets.acquire(domain,owner,now,1000n);backend=new LocalTestSigner(path('signer'),domain,packets,()=>now);
      backend.reconcile(owner,fence,{lastSequence:0n,lastObservedAt:0n});throw new Error('RESTORE_UNEXPECTEDLY_PERMITTED');
    }
    if(mode==='restore-relay'){
      relay.close();copyFileSync(path('old-relay'),path('restored-relay'));
      relay=new LocalRelay(path('restored-relay'),packets,transport,policy,()=>now);await relay.start();throw new Error('RESTORE_UNEXPECTEDLY_PERMITTED');
    }
    const rawBook=JSON.parse(body);
    const capture=(data:Record<string,unknown>)=>({data,body:JSON.stringify(data),url:'https://fixture.invalid',headers:{},attempts:1,latencyMs:0n,receivedAtMs:now});
    const provider:Provider={event:async()=>capture(event),metadata:async()=>capture(metadata),book:async()=>capture(rawBook)};
    const worker=new Worker(cfg,provider,journal,owner,()=>now);
    if(initial){await worker.poll();crash('COLLECTED');}
    else journal.acquire(worker.namespace,owner,now,1000n);
    const fence=packets.acquire(domain,owner,now,1000n);
    backend=new LocalTestSigner(path('signer'),domain,packets,()=>now);backend.reconcile(owner,fence,chainState());
    if(!initial)await relay.start();
    const payload=journal.latest(worker.namespace)!.payload;
    const evidence:SnapshotEvidence={bookBody:String((payload.book as Record<string,unknown>).body),metadata,event,
      bookReceivedAtMs:BigInt(String((payload.book as Record<string,unknown>).receivedAtMs)),
      metadataReceivedAtMs:BigInt(String((payload.metadata as Record<string,unknown>).receivedAtMs)),
      eventReceivedAtMs:BigInt(String((payload.event as Record<string,unknown>).receivedAtMs))};
    if(!packets.get(domain,1n))packets.allocate(domain,owner,fence,now,seq=>prepareObservation(cfg,reviewed,evidence,seq,now,1000n));
    crash('ALLOCATED');
    if(initial){
      const unsigned=packets.beginSign(domain,owner,fence,now,1n);crash('SIGNING');
      const pending=backend.signDigest({identity:packetNamespace(domain)+':1',digest:unsigned.digest,owner,fence});
      crash('SIGNER_RESERVED');await pending;crash('SIGNER_SIGNED');
    }
    if(!packets.get(domain,1n)!.signature)await signPrepared(packets,domain,owner,fence,1n,backend,()=>now,1000n);
    crash('SIGNED');
    await relay.deliver(cfg,owner,fence,1n,async()=>{if(relay.get(domain,1n)?.state==='READY')crash('READY');});
    await relay.reconcile(cfg,1n);crash('MINED');headOffset=1n;await relay.reconcile(cfg,1n);crash('FINALIZED');
    assert.equal(relay.get(domain,1n)!.state,'FINALIZED');
    now+=100n;rawBook.timestamp=now.toString();await worker.poll();
    const fresh={...evidence,bookBody:JSON.stringify(rawBook),bookReceivedAtMs:now};
    packets.allocate(domain,owner,fence,now,seq=>prepareObservation(cfg,reviewed,fresh,seq,now,1000n));
    await signPrepared(packets,domain,owner,fence,2n,backend,()=>now,1000n);
    await relay.deliver(cfg,owner,fence,2n);await relay.reconcile(cfg,2n);
    const deliveries=[relay.get(domain,1n)!,relay.get(domain,2n)!];
    const reservations=counterpart.prepare('SELECT nonce,raw FROM tx_reservations ORDER BY nonce').all();
    assert.ok(deliveries.every(r=>r.raw===reservations.find(t=>t.nonce===r.nonce.toString())!.raw));
    writeSync(1,json({source:'scripted fixture',externalTransactions:0,sequences:packets.list(domain).map(p=>p.packet.observation.sequence),
      nonces:deliveries.map(r=>r.nonce),finalState:deliveries[1]!.state,sourceEvidenceValid:journal.verify(),packetEvidenceValid:packets.verify(),
      transactionReservations:reservations.length,immutableTransactionRetry:true,
      broadcastCalls:Number(counterpart.prepare('SELECT sum(calls) AS n FROM sends').get()!.n)})+'\n');
  }finally{backend?.close();relay.close();packets.close();journal.close();counterpart.close();}
}
main().catch(error=>{writeSync(2,(error instanceof Error?error.message:String(error))+'\n');process.exitCode=1;});
