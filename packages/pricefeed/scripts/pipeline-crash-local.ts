import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { createPublicClient, createWalletClient, defineChain, http, keccak256, stringToHex, type Abi, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { rulesHash } from '../src/rules.js';
import { localRpcTransport } from '../src/local-rpc.js';
import { ACCEPTED_ABI } from '../src/receipts.js';
import { json } from '../src/math.js';
import { config as fixture, reviewed, metadata, event, body } from '../test/publication-fixture.js';

const pause=(ms:number)=>new Promise<void>(r=>setTimeout(r,ms));
const stages=['SIGNED','PREPARING','TX_RESERVED','TX_SIGNED','UNKNOWN','BROADCAST','MINED','FINALIZED'];
function rows(dir:string,name:string,sql:string){
  const db=new DatabaseSync(join(dir,name+'.sqlite'),{readOnly:true});try{return db.prepare(sql).all();}finally{db.close();}
}
function inventory(dir:string){return rows(dir,'packets','SELECT body,digest,signature FROM packets ORDER BY length(sequence),sequence');}
async function child(dir:string,mode:string,stage:string){
  const env={...process.env};delete env.NODE_TEST_CONTEXT;
  const processChild=spawn(process.execPath,[fileURLToPath(new URL('../test/pipeline-crash-child.js',import.meta.url)),dir,mode,stage],{env,stdio:['ignore','pipe','pipe']});
  let stdout='',stderr='';processChild.stdout.on('data',b=>{stdout+=b;});processChild.stderr.on('data',b=>{stderr+=b;});
  const timer=setTimeout(()=>processChild.kill('SIGKILL'),20000);
  try{const [code,signal]=await once(processChild,'close');return {code,signal,stdout,stderr};}finally{clearTimeout(timer);}
}
async function main(){
  const listener=createServer();listener.listen(0,'127.0.0.1');await once(listener,'listening');
  const addr=listener.address();if(!addr||typeof addr==='string')throw new Error('NO_PORT');
  const port=addr.port;await new Promise<void>((resolve,reject)=>listener.close(e=>e?reject(e):resolve()));
  const endpoint=`http://127.0.0.1:${port}`;
  const anvil=spawn(process.env.PRICEFEED_ANVIL??'anvil',['--host','127.0.0.1','--port',String(port),'--chain-id','31337','--silent'],{stdio:['ignore','ignore','pipe']});
  let spawnError:Error|undefined;anvil.on('error',e=>{spawnError=e;});anvil.stderr.resume();
  const archive=`var/pipeline-crash-${Date.now()}-${randomUUID()}`;mkdirSync(archive,{recursive:true});
  const cases:Record<string,unknown>[]=[];
  const report:Record<string,unknown>={tasks:['PF016','PF018'],baseCommit:process.env.PRICEFEED_BASE_COMMIT,archive,cases,
    chainId:31337,clock:'real elapsed host/Anvil time; no time warp or forced lease takeover',
    toolVersions:JSON.parse(process.env.PRICEFEED_TOOL_VERSIONS??'{}'),
    realComponents:['LocalPipeline.run','Worker','five SQLite journals','LocalTestSigner','LocalTransactionSigner','LocalRelay','localRpcTransport','Anvil EVM','real PriceIngress/ObservationStore','OS SIGKILL'],
    scriptedComponents:['source book/event/metadata','public test keys','owned receiver listing'],
    fullEconomicEngine:false,externalChainTransactions:0,productionApproved:false,humanGateAcceptance:false,verified:false,
    limitations:['Local chain only; production Monad/finality/keys and deployment remain open.',
      'Local public transaction key only; no production key backend or backup system.',
      'Does not simulate power loss, disk corruption, coordinated backup restore or supervisor deployment.']};
  const save=()=>{mkdirSync('artifacts/verification',{recursive:true});writeFileSync('artifacts/verification/pipeline-crash.json',json(report)+'\n');};
  const chain=defineChain({id:31337,name:'Owned crash fixture',nativeCurrency:{name:'Test Ether',symbol:'TEST',decimals:18},rpcUrls:{default:{http:[endpoint]}}});
  const client=createPublicClient({chain,transport:http(endpoint,{timeout:1000,retryCount:0})});
  const wallet=createWalletClient({account:privateKeyToAccount('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'),chain,transport:http(endpoint,{retryCount:0})});
  try{
    let ready=false;for(let i=0;i<60;i++){
      if(spawnError||anvil.exitCode!==null)throw new Error('ANVIL_FAILED');
      try{if(await client.getChainId()===31337){ready=true;break;}}catch{}await pause(100);
    }
    assert.equal(ready,true);assert.equal(await client.getBlockNumber(),0n);
    const artifact=JSON.parse(readFileSync('test/demo/out/PipelineDemoMarket.sol/PipelineDemoMarket.json','utf8')) as {abi:Abi;bytecode:{object:Hex}};
    const rpc=localRpcTransport(endpoint,artifact.abi);
    await client.request({method:'anvil_setBalance' as never,params:[rpc.sender,'0x56BC75E2D63100000'] as never});
    for(const stage of stages){
      const dir=join(archive,stage);mkdirSync(dir);
      const listedAt=BigInt(Date.now())/1000n,T=listedAt+172800n;
      const rules={...reviewed,marketId:keccak256(stringToHex('crash-market:'+stage)),sourceId:keccak256(stringToHex('crash-source:'+stage)),scheduledT:String(T)};
      const hash=await wallet.deployContract({abi:artifact.abi,bytecode:artifact.bytecode.object,args:[rules.marketId,rules.sourceId,
        fixture.destination!.signerAddress,rulesHash(rules),5000n,BigInt(rules.maxSpreadWad),listedAt,T]});
      const deployed=await client.waitForTransactionReceipt({hash,timeout:10000,pollingInterval:25});
      assert.equal(deployed.status,'success');assert.ok(deployed.contractAddress);
      const engine=deployed.contractAddress,code=await client.getBytecode({address:engine});assert.ok(code);
      const config={...fixture,poll:{...fixture.poll,intervalMs:10,timeoutMs:1,maxRetries:0,retryDelayMs:0},destination:{...fixture.destination!,
        engineAddress:engine,engineCodeHash:keccak256(code),abiHash:keccak256(stringToHex(JSON.stringify(artifact.abi))),
        marketId:rules.marketId,sourceId:rules.sourceId,sourceRulesHash:rulesHash(rules),listedAt:String(listedAt),scheduledT:String(T)}};
      writeFileSync(join(dir,'settings.json'),json({endpoint,abi:artifact.abi,config,rules,metadata,event,book:JSON.parse(body)})+'\n');
      const initialNonce=await rpc.pendingNonce();
      const killed=await child(dir,'crash',stage);
      assert.equal(killed.signal,'SIGKILL',killed.stderr);assert.equal(JSON.parse(killed.stdout).crashedAt,stage);
      const before=inventory(dir);assert.equal(before.length,1);assert.match(String(before[0]!.signature),/^0x[0-9a-f]{130}$/);
      const signerBefore=rows(dir,'transactions','SELECT nonce,request,raw,tx_hash FROM transaction_reservations');
      if(['SIGNED','PREPARING'].includes(stage))assert.equal(signerBefore.length,0);
      else {assert.equal(signerBefore.length,1);if(stage==='TX_RESERVED')assert.equal(signerBefore[0]!.raw,null);else assert.ok(signerBefore[0]!.raw);}
      const previous=rows(dir,'relay','SELECT body FROM deliveries').map(r=>JSON.parse(String(r.body)))[0]??null;
      let earlyBlocked=false;
      if(stage==='SIGNED'){
        const early=await child(dir,'early',stage);assert.equal(early.code,1);assert.match(early.stderr,/RELAY_WRITER_BUSY/);earlyBlocked=true;
      }
      // Read the actual crashed-writer lease deadlines; never override them.
      const leases=[...rows(dir,'source','SELECT until_ms FROM writers'),...rows(dir,'packets','SELECT until_ms FROM packet_workers'),...rows(dir,'relay','SELECT until_ms FROM relay_nonce')];
      const deadline=leases.reduce((n,r)=>Math.max(n,Number(r.until_ms)),0),waitMs=Math.max(0,deadline-Date.now()+50);
      console.log(json({stage,waitingForLeaseMs:waitMs}));await pause(waitMs);
      const resumed=await child(dir,'resume',stage);
        assert.equal(resumed.code,0,resumed.stderr);const result=JSON.parse(resumed.stdout);
        assert.deepEqual(result.sequences,['1','2']);assert.deepEqual(result.nonces,[String(initialNonce),String(initialNonce+1n)]);
        assert.equal(result.broadcasts,['BROADCAST','MINED','FINALIZED'].includes(stage)?1:2);
        assert.deepEqual(inventory(dir)[0],before[0]);
        const first=result.deliveries[0];if(previous?.raw){assert.equal(first.raw,previous.raw);assert.equal(first.txHash,previous.txHash);}
        const signerAfter=rows(dir,'transactions','SELECT nonce,request,raw,tx_hash FROM transaction_reservations ORDER BY length(nonce),nonce');
        assert.equal(signerAfter.length,2);
        if(signerBefore.length){
          assert.equal(signerAfter[0]!.request,signerBefore[0]!.request);
          if(signerBefore[0]!.raw)assert.equal(signerAfter[0]!.raw,signerBefore[0]!.raw);
        }
        assert.equal(signerAfter[0]!.raw,first.raw);assert.equal(signerAfter[0]!.tx_hash,first.txHash);
        assert.equal(await rpc.pendingNonce(),initialNonce+2n);
        const logs=await client.getLogs({address:engine,event:ACCEPTED_ABI[0],fromBlock:deployed.blockNumber,toBlock:'latest'});
        assert.equal(logs.length,2);assert.deepEqual(logs.map(l=>l.args.sequence),[1n,2n]);
        assert.equal(logs[0]!.args.payloadDigest,before[0]!.digest);
        assert.ok(logs.every(l=>l.args.depthValid===true&&l.args.priceWad===600000000000000000n));
        assert.deepEqual(logs.map(l=>l.transactionHash),result.deliveries.map((r:{txHash:string})=>r.txHash));
        const after=rows(dir,'relay','SELECT next_nonce FROM relay_nonce')[0]!;assert.equal(String(after.next_nonce),String(initialNonce+2n));
        cases.push({stage,status:'RESUMED',waitMs,crashDeliveryState:previous?.state??null,earlyBlocked,initialNonce,acceptedEvents:2,immutablePacket:true,immutableTransaction:!!previous?.raw||!!signerBefore[0]?.raw,transactionReservations:signerAfter.length,signerRecoveryVerified:true,...result});
      save();console.log('ANVIL_CRASH_CASE '+JSON.stringify({stage,status:cases.at(-1)!.status,acceptedEvents:cases.at(-1)!.acceptedEvents}));
    }
    report.verified=true;
  }catch(error){report.error=error instanceof Error?error.message:String(error);throw error;}
  finally{
    const closed=once(anvil,'close');anvil.kill('SIGTERM');await Promise.race([closed,pause(2000)]);
    if(anvil.exitCode===null&&anvil.signalCode===null){anvil.kill('SIGKILL');await closed;}
    const files=['src/local-relay.ts','src/pipeline.ts','src/local-rpc.ts','test/pipeline-crash-child.ts','scripts/pipeline-crash-local.ts','scripts/test-pipeline-crash.py','test/demo/src/PipelineDemoMarket.sol'];
    report.fileSha256=Object.fromEntries(files.map(p=>[p,createHash('sha256').update(readFileSync(p)).digest('hex')]));
    report.finishedAtUtc=new Date().toISOString();save();
  }
  console.log('PASS: eight joined Anvil restart paths with durable transaction signing');
}
main().catch(error=>{console.error(error instanceof Error?error.message:String(error));process.exitCode=1;});
