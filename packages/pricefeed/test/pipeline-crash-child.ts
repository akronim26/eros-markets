// Owned-Anvil child: SIGKILL skips cleanup; the parent keeps the chain alive.
import assert from 'node:assert/strict';
import { readFileSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Abi } from 'viem';
import { parseConfig } from '../src/config.js';
import { parseRules } from '../src/rules.js';
import { Journal } from '../src/journal.js';
import { PacketStore, type PacketDomain } from '../src/packet-store.js';
import { LocalTestSigner } from '../src/local-test-signer.js';
import { LocalRelay, type RelayPolicy } from '../src/local-relay.js';
import { localRpcTransport } from '../src/local-rpc.js';
import { LocalPipeline } from '../src/pipeline.js';
import { LocalTransactionSigner, type RelayTransactionRequest } from '../src/local-transaction-signer.js';
import { Worker, type Provider } from '../src/worker.js';
import { json } from '../src/math.js';
import { crashedLeaseDeadline, waitForExpiredLease } from '../scripts/crash-lease-wait.js';

async function main(){
  const [dir,mode,stage]=process.argv.slice(2);if(!dir||!['crash','resume','early'].includes(mode??'')||!stage)throw new Error('BAD_CRASH_ARGUMENTS');
  const settings=JSON.parse(readFileSync(join(dir,'settings.json'),'utf8'));
  const config=parseConfig(settings.config),rules=parseRules(settings.rules),d=config.destination!;
  const domain:PacketDomain={chainId:31337n,engine:d.engineAddress,marketId:d.marketId,sourceId:d.sourceId,rulesHash:d.sourceRulesHash,signer:d.signerAddress};
  const policy:RelayPolicy={gasCap:1000000n,maxFeePerGas:2000000000n,maxPriorityFeePerGas:1000000000n,maxCostWei:2000000000000000n,
    headroomMs:1000n,confirmations:stage==='FINALIZED'?1n:2n,timeoutMs:500,leaseMs:4000n,maxAttempts:3};
  const path=(name:string)=>join(dir,name+'.sqlite');
  const journal=new Journal(path('source')),packets=new PacketStore(path('packets'));
  const signer=new LocalTestSigner(path('signer'),domain,packets,()=>BigInt(Date.now()));
  const crash=(point:string)=>{if(mode==='crash'&&stage===point){writeSync(1,json({crashedAt:point})+'\n');process.kill(process.pid,'SIGKILL');throw new Error('KILL_FAILED');}};
  class CrashTransactionSigner extends LocalTransactionSigner {
    override async sign(request:RelayTransactionRequest){const pending=super.sign(request);crash('TX_RESERVED');return await pending;}
  }
  const transactionSigner=new CrashTransactionSigner(path('transactions'),mode==='crash');
  const rpc=localRpcTransport(settings.endpoint,settings.abi as Abi,transactionSigner);
  let broadcasts=0;
  const transport={...rpc,
    simulate:async(to: string,data:Parameters<typeof rpc.simulate>[1])=>{crash('SIGNED');await rpc.simulate(to,data);},
    prepare:async(request:Parameters<typeof rpc.prepare>[0])=>{crash('PREPARING');const raw=await rpc.prepare(request);crash('TX_SIGNED');return raw;},
    broadcast:async(raw:Parameters<typeof rpc.broadcast>[0])=>{
      crash('UNKNOWN');broadcasts++;const hash=await rpc.broadcast(raw);
      // Ensure acceptance really reached the owned EVM before losing the RPC result.
      if(mode==='crash'&&stage==='BROADCAST'){
        let receipt=await rpc.receipt(hash);
        for(let i=0;!receipt&&i<40;i++){await new Promise(r=>setTimeout(r,25));receipt=await rpc.receipt(hash);}
        assert.equal(receipt?.status,'success');crash('BROADCAST');
      }
      return hash;
    },
  };
  const capture=(data:Record<string,unknown>)=>({data,body:JSON.stringify(data),url:'fixture://owned-chain-crash',headers:{},attempts:1,latencyMs:0n,receivedAtMs:BigInt(Date.now())});
  const provider:Provider={event:async()=>capture(settings.event),metadata:async()=>capture(settings.metadata),
    book:async()=>capture({...settings.book,timestamp:String(Date.now())})};
  const worker=new Worker(config,provider,journal,randomUUID());
  const relay=new LocalRelay(path('relay'),packets,transport,policy);
  const pipeline=new LocalPipeline([{worker,rules,signer}],packets,relay,transport,policy);
  // Check with this process's actual wall clock too; WSL timer/clock adjustments
  // can occur between the parent's wait and child startup. Keep the early case early.
  if(mode==='resume')await waitForExpiredLease(()=>crashedLeaseDeadline(dir));
  const stop=new AbortController(),timer=setTimeout(()=>stop.abort(),12000);
  try{
    await pipeline.start();
    if(mode==='early')throw new Error('EARLY_TAKEOVER_ALLOWED');
    await pipeline.run(stop.signal,result=>{
      if(result.state==='MINED')crash('MINED');
      if(result.state==='FINALIZED')crash('FINALIZED');
      if(mode==='resume'&&result.sequence===2n&&['MINED','FINALIZED'].includes(result.state))stop.abort();
    });
    assert.equal(mode,'resume','crash boundary not reached');
    const rows=packets.list(domain),deliveries=rows.map(p=>relay.get(domain,p.packet.observation.sequence)!);
    assert.deepEqual(rows.map(p=>p.packet.observation.sequence),[1n,2n]);
    assert.ok(deliveries.every(r=>r.accepted),'missing canonical acceptance');
    assert.equal(deliveries[1]!.nonce,deliveries[0]!.nonce+1n);
    assert.equal(journal.verify(),true);assert.equal(packets.verify(),true);
    writeSync(1,json({sequences:[1n,2n],nonces:deliveries.map(r=>r.nonce),broadcasts,
      deliveries,sourceEvidenceValid:true,packetEvidenceValid:true,externalTransactions:0})+'\n');
  }finally{clearTimeout(timer);pipeline.close();relay.close();signer.close();packets.close();journal.close();transactionSigner.close();}
}
main().catch(error=>{writeSync(2,(error instanceof Error?error.message:String(error))+'\n');process.exitCode=1;});
