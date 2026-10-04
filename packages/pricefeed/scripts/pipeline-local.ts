import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { createPublicClient, createWalletClient, defineChain, http, keccak256, parseAbi, stringToHex, type Abi, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { parseConfig, type MarketConfig } from '../src/config.js';
import { metadataIdentity, verifyEventMembership } from '../src/collector.js';
import { Journal } from '../src/journal.js';
import { PacketStore, type PacketDomain } from '../src/packet-store.js';
import { LocalTestSigner } from '../src/local-test-signer.js';
import { LocalTransactionSigner } from '../src/local-transaction-signer.js';
import { LocalRelay, type RelayPolicy } from '../src/local-relay.js';
import { localRpcTransport } from '../src/local-rpc.js';
import { LocalPipeline, type PipelineResult } from '../src/pipeline.js';
import { DEVELOPMENT_INVALID_POLICIES } from '../src/publication.js';
import { PRICING_POLICY, rulesHash, type RulesManifest } from '../src/rules.js';
import { PublicPolymarket, RequestLimiter } from '../src/polymarket.js';
import { Worker, type Provider } from '../src/worker.js';
import { json } from '../src/math.js';
import { expectedDemoTwap } from './demo-packet.js';

const pause=(ms:number)=>new Promise<void>(resolve=>setTimeout(resolve,ms));
const hash=(s:string)=>keccak256(stringToHex(s));
async function main(){
  const options=new Map<string,string>(),args=process.argv.slice(2);
  for(let i=0;i<args.length;i+=2){const key=args[i],value=args[i+1];
    if(!key||!['--source','--config','--duration-seconds','--scenario','--restart-after-seconds','--require-full-window'].includes(key)||!value||options.has(key))throw new Error('BAD_PIPELINE_ARGUMENTS');options.set(key,value);}
  const mode=options.get('--source')??'fixture',seconds=options.get('--duration-seconds')??'3',scenario=options.get('--scenario')??'valid';
  if(!['fixture','polymarket'].includes(mode)||!/^\d+$/.test(seconds)||BigInt(seconds)<1n||BigInt(seconds)>900n)throw new Error('SOURCE_FIXTURE_OR_POLYMARKET_DURATION_1_TO_900');
  if(!['valid','transitions'].includes(scenario)||scenario==='transitions'&&(mode!=='fixture'||BigInt(seconds)<6n))throw new Error('TRANSITIONS_REQUIRE_FIXTURE_SOURCE_AND_AT_LEAST_6_SECONDS');
  const restart=options.get('--restart-after-seconds'),requireWindow=options.get('--require-full-window')??'false';
  if(restart&&(!/^[1-9]\d*$/.test(restart)||BigInt(restart)>=BigInt(seconds)||scenario!=='valid'))throw new Error('RESTART_MUST_PRECEDE_END_OF_VALID_SCENARIO');
  if(!['true','false'].includes(requireWindow))throw new Error('REQUIRE_FULL_WINDOW_BOOLEAN');
  const base=parseConfig(JSON.parse(readFileSync(options.get('--config')??'config/crypto.example.json','utf8')));
  if(base.enabled||base.destination)throw new Error('DISABLED_SOURCE_CONFIG_WITHOUT_DESTINATION_REQUIRED');
  const listener=createServer();listener.listen(0,'127.0.0.1');await once(listener,'listening');
  const address=listener.address();if(!address||typeof address==='string')throw new Error('NO_LOCAL_PORT');
  const port=address.port;await new Promise<void>((resolve,reject)=>listener.close(e=>e?reject(e):resolve()));
  const endpoint=`http://127.0.0.1:${port}`;
  const anvil=spawn(process.env.PRICEFEED_ANVIL??'anvil',['--host','127.0.0.1','--port',String(port),'--chain-id','31337','--silent'],{stdio:['ignore','ignore','pipe']});
  let spawnError:Error|undefined;anvil.on('error',error=>{spawnError=error;});anvil.stderr.resume();
  const chain=defineChain({id:31337,name:'Owned pipeline smoke chain',nativeCurrency:{name:'Test Ether',symbol:'TEST',decimals:18},rpcUrls:{default:{http:[endpoint]}}});
  const client=createPublicClient({chain,transport:http(endpoint,{timeout:1000,retryCount:0})});
  const deployer=privateKeyToAccount('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80');
  const wallet=createWalletClient({account:deployer,chain,transport:http(endpoint,{retryCount:0})});
  const startedAt=Date.now(),directory=`var/pipeline-${startedAt}-${randomUUID()}`;mkdirSync(directory,{recursive:true});
  let journal=new Journal(`${directory}/source.sqlite`),packets=new PacketStore(`${directory}/packets.sqlite`),storesOpen=true;
  let signer:LocalTestSigner|undefined,relay:LocalRelay|undefined,pipeline:LocalPipeline|undefined;
  let transactionSigner:LocalTransactionSigner|undefined,transactionJournalCreated=false;
  const results:PipelineResult[]=[],report:Record<string,unknown>={mode:mode==='fixture'?'FIXTURE_SOURCE_REAL_LOCAL_INGRESS':'LIVE_SOURCE_REAL_LOCAL_INGRESS',
    source:mode,scenario,chainId:31337,startedAt,archive:directory,results,externalChainTransactions:0,productionApproved:false,
    toolVersions:process.env.PRICEFEED_TOOL_VERSIONS?JSON.parse(process.env.PRICEFEED_TOOL_VERSIONS):null,
    fullEconomicEngine:false,completed:false};
  const save=()=>{mkdirSync('artifacts/pipeline',{recursive:true});const body=json(report)+'\n';
    writeFileSync(`artifacts/pipeline/${directory.slice(4)}.json`,body);
    writeFileSync(`artifacts/pipeline/${mode}-${scenario}.json`,body);writeFileSync('artifacts/pipeline/latest.json',body);};
  const stop=new AbortController(),shutdown=()=>stop.abort();process.once('SIGINT',shutdown);process.once('SIGTERM',shutdown);
  try{
    let ready=false;
    for(let i=0;i<60;i++){if(spawnError||anvil.exitCode!==null)throw new Error(`ANVIL_FAILED:${spawnError?.message??anvil.exitCode}`);
      try{if(await client.getChainId()===31337){ready=true;break;}}catch{}await pause(100);}
    if(!ready)throw new Error('LOCAL_CHAIN_NOT_READY');assert.equal(await client.getBlockNumber(),0n);
    const cfgSource=mode==='fixture'?{...base,poll:{...base.poll,intervalMs:100}}:base;
    const metadata={id:base.mapping.externalMarketId,conditionId:base.mapping.conditionId,outcomes:[base.mapping.outcomeLabel,'Other fixture outcome'],
      clobTokenIds:[base.mapping.outcomeTokenId,'2'],question:'Synthetic pipeline test question',description:'Fixture only; not an approved Eros market',
      active:true,closed:false,enableOrderBook:true,acceptingOrders:true};
    const event={id:base.mapping.eventId,markets:[{id:base.mapping.externalMarketId}],active:true,closed:false};
    const capture=(data:Record<string,unknown>)=>({url:'fixture://pipeline',receivedAtMs:BigInt(Date.now()),latencyMs:0n,headers:{},data,body:JSON.stringify(data),attempts:1});
    let scenarioStartedAt:number|undefined;
    const provider:Provider=mode==='polymarket'?new PublicPolymarket(base.poll,new RequestLimiter(100,20)):{
      event:async()=>capture(event),metadata:async()=>capture(metadata),book:async()=>{
        const stage=scenario==='transitions'&&scenarioStartedAt!==undefined?Math.floor((Date.now()-scenarioStartedAt)/1000):0;
        return capture({market:base.mapping.conditionId,asset_id:base.mapping.outcomeTokenId,
          ...(stage===2?{}:{timestamp:String(Date.now())}),hash:`synthetic-test-book-stage-${stage}`,tick_size:'0.01',min_order_size:'5',
          bids:[{price:stage>=4?'0.62':'0.59',size:stage===3?'1':'10000'}],
          asks:[{price:stage===1?'0.90':stage>=4?'0.64':'0.61',size:'10000'}]});}};
    const probe=await new Worker(cfgSource,provider,journal,randomUUID()).poll();
    if(probe.inspection.status!=='COLLECTING'||!probe.metadata||!probe.event)throw new Error(`SOURCE_UNAVAILABLE:${probe.inspection.reason}`);
    const externalRulesDigest='0x'+createHash('sha256').update(`${verifyEventMembership(base,probe.event.data).rulesDigest}:${metadataIdentity(base,probe.metadata.data).rulesDigest}`).digest('hex');
    const listedAt=BigInt(Date.now())/1000n,T=listedAt+172800n;
    const rules:RulesManifest={schemaVersion:'1',venue:'polymarket',...base.mapping,marketId:hash(`LOCAL_PIPELINE:${base.key}`),
      sourceId:hash(`LOCAL_PIPELINE_SOURCE:${base.mapping.outcomeTokenId}`),erosRulesHash:hash('LOCAL_TEST_RULES'),externalRulesDigest,
      ...DEVELOPMENT_INVALID_POLICIES,scheduledT:String(T),
      depthNLots:base.pricing.depthNLots,maxSpreadWad:base.pricing.maxSpreadWad,pricingPolicy:PRICING_POLICY};
    const fixtureSigner=privateKeyToAccount(('0x'+'11'.repeat(32)) as Hex);
    const artifact=JSON.parse(readFileSync('test/demo/out/PipelineDemoMarket.sol/PipelineDemoMarket.json','utf8')) as {abi:Abi;bytecode:{object:Hex}};
    const deployment=await wallet.deployContract({abi:artifact.abi,bytecode:artifact.bytecode.object,args:[rules.marketId,rules.sourceId,
      fixtureSigner.address,rulesHash(rules),BigInt(rules.depthNLots),BigInt(rules.maxSpreadWad),listedAt,T]});
    const receipt=await client.waitForTransactionReceipt({hash:deployment,timeout:10000,pollingInterval:100});
    if(receipt.status!=='success'||!receipt.contractAddress)throw new Error('LOCAL_RECEIVER_CREATION_FAILED');
    const engine=receipt.contractAddress,code=await client.getBytecode({address:engine});if(!code)throw new Error('MISSING_ENGINE_CODE');
    const config:MarketConfig={...cfgSource,destination:{chainId:'31337',engineAddress:engine,engineCodeHash:keccak256(code),
      abiHash:keccak256(stringToHex(JSON.stringify(artifact.abi))),marketId:rules.marketId,sourceId:rules.sourceId,sourceRulesHash:rulesHash(rules),
      signerAddress:fixtureSigner.address,listedAt:String(listedAt),scheduledT:String(T),invalidRule:{fallbackListed:true,captureGraceSecs:'3600',voidSecs:'2592000',fallbackPriceWad:'500000000000000000'}}};
    const domain:PacketDomain={chainId:31337n,engine,marketId:rules.marketId,sourceId:rules.sourceId,rulesHash:rulesHash(rules),signer:fixtureSigner.address};
    let transport=localRpcTransport(endpoint,artifact.abi);
    // Only fund the public fixture relay on the fresh owned chain.
    await client.request({method:'anvil_setBalance' as never,params:[transport.sender,'0x56BC75E2D63100000'] as never});
    const policy:RelayPolicy={gasCap:1000000n,maxFeePerGas:2000000000n,maxPriorityFeePerGas:1000000000n,maxCostWei:2000000000000000n,
      headroomMs:1000n,confirmations:1n,timeoutMs:5000,maxAttempts:3,leaseMs:60000n};
    const collectorOwner=randomUUID();
    const makePipeline=()=>{
      transactionSigner=new LocalTransactionSigner(`${directory}/transactions.sqlite`,!transactionJournalCreated);transactionJournalCreated=true;
      transport=localRpcTransport(endpoint,artifact.abi,transactionSigner);
      report.transactionJournal={id:transactionSigner.id,file:'transactions.sqlite',publicFixture:true};
      signer=new LocalTestSigner(`${directory}/signer.sqlite`,domain,packets,()=>BigInt(Date.now()));
      relay=new LocalRelay(`${directory}/relay.sqlite`,packets,transport,policy);
      const resumedWorker=new Worker(config,provider,journal,collectorOwner);
      pipeline=new LocalPipeline([{worker:resumedWorker,rules,signer}],packets,relay,transport,policy);
    };
    makePipeline();
    report.config=config;report.rules=rules;report.receiver=engine;save();
    scenarioStartedAt=Date.now();
    const immutable=()=>packets.list(domain).map(p=>({packet:p.packet,digest:p.digest,signature:p.signature,
      raw:relay!.get(domain,p.packet.observation.sequence)?.raw??null,nonce:relay!.get(domain,p.packet.observation.sequence)?.nonce??null}));
    const runPhase=async(durationMs:number)=>{
      const phase=new AbortController(),forward=()=>phase.abort();stop.signal.addEventListener('abort',forward,{once:true});
      if(stop.signal.aborted)forward();const timer=setTimeout(()=>phase.abort(),durationMs);
      try{await pipeline!.run(phase.signal,result=>{results.push(result);save();console.log(json(result));});}
      finally{clearTimeout(timer);stop.signal.removeEventListener('abort',forward);}
    };
    const runStarted=Date.now();
    await runPhase(Number(restart??seconds)*1000);
    if(restart&&!stop.signal.aborted){
      const before=immutable(),chainBefore=await transport.identity(domain),restartAt=Date.now();
      assert.ok(before.length>0,'no persisted packet before restart');
      // Graceful in-process restart: close all five databases and reconstruct every
      // worker/signing/relay object. The owned chain stays running; no timestamps are warped.
      pipeline!.close();relay!.close();signer!.close();transactionSigner!.close();packets.close();journal.close();storesOpen=false;
      journal=new Journal(`${directory}/source.sqlite`);packets=new PacketStore(`${directory}/packets.sqlite`);storesOpen=true;
      makePipeline();await pipeline!.start();
      assert.deepEqual(immutable(),before,'restart changed immutable packet/signature/transaction');
      assert.equal(journal.verify(),true);assert.equal(packets.verify(),true);
      report.restart={kind:'GRACEFUL_IN_PROCESS_JOURNAL_REOPEN',atMs:restartAt,resumedAtMs:Date.now(),
        chainSequenceBefore:chainBefore.lastSequence,preservedPackets:before.length,immutableVerified:true};save();
      await runPhase(Math.max(1,Number(seconds)*1000-(Date.now()-runStarted)));
      const after=packets.list(domain),lastBefore=before.at(-1)!.packet.observation.sequence;
      assert.ok(after.some(p=>p.packet.observation.sequence>lastBefore),'no new sequence after restart');
      assert.deepEqual(immutable().slice(0,before.length),before,'old packet changed after restart');
      const chainAfter=await transport.identity(domain);
      assert.ok(chainAfter.lastSequence>chainBefore.lastSequence,'no accepted packet after restart');
      Object.assign(report.restart as object,{chainSequenceAfter:chainAfter.lastSequence,verified:true});
    }
    if(stop.signal.aborted)throw new Error('DEMO_INTERRUPTED');
    report.runDurationMs=Date.now()-runStarted;
    const accepted=packets.list(domain).filter(p=>relay!.get(domain,p.packet.observation.sequence)?.accepted);
    assert.ok(accepted.length>0,'no matching accepted observation');
    // Mine a final ordinary local block at the real clock so quiet-chain state
    // cannot make an old evaluation endpoint look like current availability.
    await client.request({method:'evm_mine' as never,params:[] as never});
    const block=await client.getBlock({blockTag:'latest'});
    const twap=await client.readContract({address:engine,abi:parseAbi(['function indexTwap300(uint64) view returns ((bool available,int256 twapWad,uint256 coveredSecs,int256 integral))']),
      functionName:'indexTwap300',args:[block.timestamp],blockNumber:block.number});
    const expected=expectedDemoTwap(accepted.map(p=>{const receipt=relay!.get(domain,p.packet.observation.sequence)!.accepted!;
      return {t:p.packet.observation.observedAt,price:receipt.priceWad,valid:receipt.depthValid};}),block.timestamp);
    for(const field of ['available','twapWad','coveredSecs','integral'] as const)assert.equal(twap[field],expected[field]);
    report.packets=accepted.map(p=>({packet:p.packet,digest:p.digest,signature:p.signature,delivery:relay!.get(domain,p.packet.observation.sequence)}));
    report.acceptedPackets=accepted.length;report.twap={actual:twap,expected,verified:true,
      evaluationBlock:{number:block.number,hash:block.hash,timestamp:block.timestamp}};
    if(requireWindow==='true')assert.equal(twap.available,true,'full 300-second valid coverage not established');
    const nonces=accepted.map(p=>relay!.get(domain,p.packet.observation.sequence)!.nonce.toString());
    assert.equal(new Set(nonces).size,nonces.length,'transaction nonce reused');
    for(let i=1;i<accepted.length;i++){
      assert.ok(accepted[i]!.packet.observation.sequence>accepted[i-1]!.packet.observation.sequence);
      assert.ok(accepted[i]!.packet.sourceMs>=accepted[i-1]!.packet.sourceMs,'authentic source time regressed');
    }
    report.ordering={uniqueNonces:true,increasingSequences:true,nondecreasingSourceTime:true};
    assert.equal(journal.verify(),true);assert.equal(packets.verify(),true);
    report.packets=accepted.map(p=>({packet:p.packet,digest:p.digest,signature:p.signature,delivery:relay!.get(domain,p.packet.observation.sequence)}));
    if(scenario==='transitions'){
      const invalid=results.filter(r=>r.depthValid===false),valid=results.filter(r=>r.depthValid===true),gaps=results.filter(r=>r.state==='SOURCE_UNAVAILABLE');
      assert.ok(invalid.length>0,'invalid checkpoint not accepted');assert.ok(gaps.some(r=>r.reason==='MISSING_OR_BAD_SOURCE_TIME'),'missing-time gap not retained');
      assert.ok(valid.some(r=>r.sequence!>invalid.at(-1)!.sequence!),'no valid recovery after invalid checkpoint');
      assert.ok(accepted.some(p=>p.packet.observation.priceWad===630000000000000000n),'recovery price does not match independent fixture value');
      report.transitionChecks={verified:true,invalidPackets:invalid.length,validPackets:valid.length,sourceGaps:gaps.length};
    }
    report.completed=true;
  }catch(error){report.error=error instanceof Error?error.message:String(error);throw error;}
  finally{
    pipeline?.close();relay?.close();signer?.close();transactionSigner?.close();if(storesOpen){packets.close();journal.close();}
    report.archiveSha256=Object.fromEntries(['source.sqlite','packets.sqlite','signer.sqlite','relay.sqlite','transactions.sqlite']
      .filter(name=>{try{readFileSync(`${directory}/${name}`);return true;}catch{return false;}})
      .map(name=>[name,createHash('sha256').update(readFileSync(`${directory}/${name}`)).digest('hex')]));
    process.removeListener('SIGINT',shutdown);process.removeListener('SIGTERM',shutdown);
    const closed=once(anvil,'close');anvil.kill('SIGTERM');await Promise.race([closed,pause(2000)]);
    if(anvil.exitCode===null&&anvil.signalCode===null)anvil.kill('SIGKILL');report.finishedAt=Date.now();save();
  }
  console.log(json({completed:report.completed,source:mode,acceptedPackets:report.acceptedPackets,report:'artifacts/pipeline/latest.json',externalChainTransactions:0}));
}
main().catch(error=>{console.error(error instanceof Error?error.message:String(error));process.exitCode=1;});
