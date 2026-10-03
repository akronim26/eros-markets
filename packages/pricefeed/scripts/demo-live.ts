import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createPublicClient, createWalletClient, defineChain, http, keccak256, parseAbi, parseEventLogs, stringToHex, type Abi, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { parseConfig } from '../src/config.js';
import { PublicPolymarket, RequestLimiter } from '../src/polymarket.js';
import { Journal } from '../src/journal.js';
import { Worker } from '../src/worker.js';
import { decimalWad, json } from '../src/math.js';
import { OBSERVATION_FIELDS, observationDigest, submitCalldata } from '../src/wire.js';
import { demoObservation, expectedDemoTwap, type DemoSample } from './demo-packet.js';

const readAbi=parseAbi([
  'function sourceState(bytes32) view returns ((address signer,bytes32 rulesHash,uint64 lastSequence,uint64 lastObservedAt,bool configured))',
  'function indexTwap300(uint64) view returns ((bool available,int256 twapWad,uint256 coveredSecs,int256 integral))',
  'event ObservationAccepted(bytes32 indexed sourceId,uint64 sequence,uint64 observedAt,uint64 publishedAt,uint64 acceptedAt,uint256 priceWad,bool depthValid,bytes32 payloadDigest)',
]);
const digestAbi=[{type:'function',name:'observationDigest',stateMutability:'view',
  inputs:[{name:'o',type:'tuple',components:OBSERVATION_FIELDS.map(([name,type])=>({name,type}))}],
  outputs:[{name:'',type:'bytes32'}]}] as const;
const pause=(ms:number)=>new Promise<void>(resolve=>setTimeout(resolve,ms));
const sha256=(body:string)=>createHash('sha256').update(body).digest('hex');

async function main() {
  const options=new Map<string,string>();
  const args=process.argv.slice(2);
  for(let i=0;i<args.length;i+=2){const key=args[i],value=args[i+1];
    if(!key||!['--config','--duration-seconds'].includes(key)||!value||options.has(key))throw new Error('DEMO_ARGUMENTS: --config PATH --duration-seconds 10..900');
    options.set(key,value);}
  const seconds=options.get('--duration-seconds')??'360';
  if(!/^[1-9]\d*$/.test(seconds)||BigInt(seconds)<10n||BigInt(seconds)>900n)throw new Error('DEMO_DURATION_10_TO_900_SECONDS');
  const cfg=parseConfig(JSON.parse(readFileSync(options.get('--config')??'config/crypto.example.json','utf8')));
  if(cfg.enabled||cfg.destination!==null)throw new Error('DEMO_REQUIRES_DISABLED_SOURCE_CONFIG_WITHOUT_DESTINATION');

  const listener=createServer();listener.listen(0,'127.0.0.1');await once(listener,'listening');
  const address=listener.address();if(!address||typeof address==='string')throw new Error('NO_LOCAL_DEMO_PORT');
  const port=address.port;await new Promise<void>((resolve,reject)=>listener.close(error=>error?reject(error):resolve()));
  // A new owned loopback-only chain is created for each run. No caller-supplied RPC or key.
  const anvil=spawn(process.env.PRICEFEED_ANVIL??'anvil',['--host','127.0.0.1','--port',String(port),'--chain-id','31337','--accounts','1','--silent'],{stdio:['ignore','ignore','pipe']});
  let spawnError:Error|undefined,anvilError='';
  anvil.on('error',error=>{spawnError=error;});
  anvil.stderr.on('data',(chunk:Buffer)=>{if(anvilError.length<4000)anvilError+=chunk.toString();});
  const endpoint=`http://127.0.0.1:${port}`;
  const chain=defineChain({id:31337,name:'Pricefeed owned local demo',nativeCurrency:{name:'Test Ether',symbol:'TEST',decimals:18},rpcUrls:{default:{http:[endpoint]}}});
  const transport=http(endpoint,{timeout:5000,retryCount:0});
  const client=createPublicClient({chain,transport});
  // Public Anvil account and public source fixture key. Never operational secrets.
  const sender=privateKeyToAccount('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80');
  const signer=privateKeyToAccount(('0x'+'11'.repeat(32)) as Hex);
  const wallet=createWalletClient({account:sender,chain,transport});
  const startedAtMs=BigInt(Date.now()),archive=`var/live-demo-${startedAtMs}.sqlite`;
  mkdirSync('var',{recursive:true});mkdirSync('artifacts/demo',{recursive:true});
  const journal=new Journal(archive),samples:DemoSample[]=[],attempts:Record<string,unknown>[]=[];
  const manifest={mode:'LOCAL_DEMO_ONLY',mapping:cfg.mapping,pricing:cfg.pricing,
    sourceTime:'preserve vendor milliseconds; floor to seconds for demo',publishedAt:'local packet freeze time; demo only',
    units:cfg.policies.quantityPolicyId,quote:cfg.policies.quotePolicyId,
    invalid:'do not sign unavailable/invalid source; preserve gaps',productionApproved:false};
  const domain={chainId:31337n as const,marketId:keccak256(stringToHex(`LOCAL_DEMO:${cfg.key}`)),
    sourceId:keccak256(stringToHex(`LOCAL_DEMO_POLYMARKET:${cfg.mapping.conditionId}:${cfg.mapping.outcomeTokenId}`)),
    sourceRulesHash:keccak256(stringToHex(json(manifest)))};
  const report:Record<string,unknown>={mode:'LOCAL_DEMO_ONLY',startedAtMs,sourceConfig:cfg,manifest,
    chainId:31337,engineKind:'real PriceIngress + ObservationStore with local demo constructor',
    fullMarginEngine:false,oracle:false,clob:false,sourceArchive:archive,
    externalChainTransactions:0,productionApproved:false,humanGatesAccepted:false,attempts};
  const save=()=>writeFileSync('artifacts/demo/latest.json',json(report)+'\n');
  let stopping=false;const stop=()=>{stopping=true;};process.once('SIGINT',stop);process.once('SIGTERM',stop);
  try {
    let ready=false;
    for(let i=0;i<60;i++){
      if(spawnError||anvil.exitCode!==null)throw new Error(`LOCAL_DEMO_CHAIN_FAILED: ${spawnError?.message??anvilError}`);
      try{if(await client.getChainId()===31337){ready=true;break;}}catch{}
      await pause(100);
    }
    if(!ready)throw new Error('LOCAL_DEMO_CHAIN_NOT_READY');
    assert.equal(await client.getBlockNumber(),0n);
    assert.ok((await wallet.getAddresses()).some(value=>value.toLowerCase()===sender.address.toLowerCase()));
    const artifact=JSON.parse(readFileSync('test/demo/out/LiveDemoMarket.sol/LiveDemoMarket.json','utf8')) as {abi:Abi;bytecode:{object:Hex}};
    const deployHash=await wallet.deployContract({abi:artifact.abi,bytecode:artifact.bytecode.object,
      args:[domain.marketId,domain.sourceId,signer.address,domain.sourceRulesHash,BigInt(cfg.pricing.depthNLots),BigInt(cfg.pricing.maxSpreadWad),BigInt(Date.now())/1000n+172800n]});
    const deployment=await client.waitForTransactionReceipt({hash:deployHash,timeout:10000,pollingInterval:100});
    if(deployment.status!=='success'||!deployment.contractAddress)throw new Error('DEMO_DEPLOYMENT_FAILED');
    const engine=deployment.contractAddress;
    report.engineAddress=engine;report.deploymentTransactionHash=deployHash;report.signerAddress=signer.address;report.domain=domain;save();
    console.log(json({demo:'started',source:cfg.mapping,engineAddress:engine,chainId:31337,intervalMs:cfg.poll.intervalMs,archive}));
    const worker=new Worker(cfg,new PublicPolymarket(cfg.poll,new RequestLimiter(100,20)),journal,randomUUID());
    const beginning=process.hrtime.bigint(),duration=BigInt(seconds)*1000000000n;
    while(!stopping&&process.hrtime.bigint()-beginning<duration){
      const tick=process.hrtime.bigint(),result=await worker.poll();
      const evidence=Object.fromEntries((['event','metadata','book'] as const).filter(kind=>result[kind]).map(kind=>[kind,{url:result[kind]!.url,receivedAtMs:result[kind]!.receivedAtMs,bodySha256:sha256(result[kind]!.body)}]));
      const attempt:Record<string,unknown>={atMs:result.atMs,status:result.inspection.status,reason:result.inspection.reason,sourceTime:result.inspection.time,summary:result.inspection.summary,evidence};
      attempts.push(attempt);
      if(result.inspection.status==='COLLECTING'){
        const state=await client.readContract({address:engine,abi:readAbi,functionName:'sourceState',args:[domain.sourceId]});
        const obs=demoObservation(result,domain,state.lastSequence+1n,BigInt(Date.now()));
        const digest=observationDigest(obs,31337n,engine),signature=await signer.sign({hash:digest});
        const tuple={...obs,marketId:obs.marketId as Hex,sourceId:obs.sourceId as Hex,sourceRulesHash:obs.sourceRulesHash as Hex};
        assert.equal(await client.readContract({address:engine,abi:digestAbi,functionName:'observationDigest',args:[tuple]}),digest);
        attempt.packet={obs,digest,signature};save(); // Freeze and retain packet before sending.
        const hash=await wallet.sendTransaction({to:engine,data:submitCalldata(obs,signature),gas:1000000n});
        attempt.transactionHash=hash;save();
        const receipt=await client.waitForTransactionReceipt({hash,timeout:10000,pollingInterval:100});
        assert.equal(receipt.status,'success');
        const events=parseEventLogs({abi:readAbi,logs:receipt.logs,eventName:'ObservationAccepted'});
        assert.equal(events.length,1);const event=events[0]!;
        assert.equal(event.address.toLowerCase(),engine.toLowerCase());assert.equal(event.args.payloadDigest,digest);
        assert.equal(event.args.sourceId,domain.sourceId);assert.equal(event.args.sequence,obs.sequence);
        assert.equal(event.args.observedAt,obs.observedAt);assert.equal(event.args.publishedAt,obs.publishedAt);
        assert.equal(event.args.depthValid,true);assert.equal(event.args.priceWad,obs.priceWad);
        const acceptedState=await client.readContract({address:engine,abi:readAbi,functionName:'sourceState',args:[domain.sourceId]});
        assert.equal(acceptedState.lastSequence,obs.sequence);
        samples.push({t:obs.observedAt,price:obs.priceWad,valid:true});
        const block=await client.getBlock({blockNumber:receipt.blockNumber});assert.equal(event.args.acceptedAt,block.timestamp);
        const twap=await client.readContract({address:engine,abi:readAbi,functionName:'indexTwap300',args:[block.timestamp]});
        const expected=expectedDemoTwap(samples,block.timestamp);
        for(const field of ['available','twapWad','coveredSecs','integral'] as const)assert.equal(twap[field],expected[field]);
        attempt.accepted={...event.args,blockNumber:receipt.blockNumber,transactionHash:hash};attempt.twap={...twap,expected,verified:true};
        if(!report.firstSourceExample){writeFileSync('artifacts/demo/source-example.json',json({receivedAtMs:result.book!.receivedAtMs,book:result.book!.data,body:result.book!.body,bodySha256:sha256(result.book!.body)})+'\n');report.firstSourceExample='artifacts/demo/source-example.json';}
        console.log(json({sequence:obs.sequence,observedAt:obs.observedAt,depthMid:decimalWad(obs.priceWad),accepted:true,transactionHash:hash,coveredSecs:twap.coveredSecs,indexAvailable:twap.available,indexTwap:twap.available?decimalWad(twap.twapWad):null}));
      }else console.log(json({status:result.inspection.status,reason:result.inspection.reason,sent:false}));
      save();
      const elapsed=Number((process.hrtime.bigint()-tick)/1000000n),delay=Math.max(0,cfg.poll.intervalMs-elapsed);
      if(process.hrtime.bigint()-beginning+BigInt(delay)*1000000n>=duration)break;
      await pause(delay);
    }
    report.acceptedPackets=samples.length;report.completed=true;report.evidenceIntegrity=journal.verify();
    report.result=samples.length>0?'LIVE_SOURCE_LOCAL_INGRESS_PASS':'UNAVAILABLE_NO_ACCEPTED_PACKET';
    if(!samples.length)process.exitCode=2;
  }catch(error){report.error=error instanceof Error?error.message:String(error);report.completed=false;throw error;}
  finally {
    report.finishedAtMs=BigInt(Date.now());save();journal.close();
    process.removeListener('SIGINT',stop);process.removeListener('SIGTERM',stop);
    const closed=once(anvil,'close');anvil.kill('SIGTERM');await Promise.race([closed,pause(2000)]);
    if(anvil.exitCode===null&&anvil.signalCode===null)anvil.kill('SIGKILL');
  }
  console.log(json({result:report.result,acceptedPackets:samples.length,report:'artifacts/demo/latest.json',externalChainTransactions:0}));
}
main().catch(error=>{console.error(error instanceof Error?error.message:String(error));process.exitCode=1;});
