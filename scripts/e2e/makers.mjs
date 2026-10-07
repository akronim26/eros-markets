import {makerReadinessDelay} from './maker-readiness-policy.mjs';
import fs from 'node:fs'; import {parseEnv} from 'node:util'; import {createRequire} from 'node:module';
const require=createRequire(new URL('../../frontend/package.json',import.meta.url));
const {createPublicClient,createWalletClient,http,keccak256,encodeFunctionData,decodeEventLog}=require('viem');
const {privateKeyToAccount}=require('viem/accounts'); const {monadTestnet}=require('viem/chains');
const [publicDir,privateDir,rpcFile]=process.argv.slice(2);
if(!publicDir?.startsWith('artifacts/deployments/')||!privateDir?.startsWith('tmp/')||!rpcFile)throw Error('EXPLICIT_CAMPAIGN_PATHS_REQUIRED');
const roles=parseEnv(fs.readFileSync(privateDir+'/roles.env','utf8'));
const m=JSON.parse(fs.readFileSync(publicDir+'/services/market-ops.json'));
const sourceId=JSON.parse(fs.readFileSync(publicDir+'/services/pricefeed-config.json')).destination.sourceId;
const abi=JSON.parse(fs.readFileSync('artifacts/risk/book-risk-engine-abi.json')).abi;
const rpc=parseEnv(fs.readFileSync(rpcFile,'utf8')).MONAD_TESTNET_RPC,client=createPublicClient({chain:monadTestnet,transport:http(rpc)});
const path=privateDir+'/maker-journal.json',logPath=privateDir+'/maker-evidence.jsonl';
let state=fs.existsSync(path)?JSON.parse(fs.readFileSync(path,'utf8')):{engine:m.engine,completed:[]};
if(state.engine!==m.engine)throw Error('MAKER_JOURNAL_ENGINE_MISMATCH');
const save=()=>{fs.writeFileSync(path+'.tmp',JSON.stringify(state,null,2)+'\n',{mode:0o600});fs.renameSync(path+'.tmp',path)};
const log=v=>{const s=JSON.stringify({at:new Date().toISOString(),...v},(_,v)=>typeof v==='bigint'?v.toString():v);fs.appendFileSync(logPath,s+'\n');console.log(s)};
const read=(functionName,args=[],blockNumber)=>client.readContract({address:m.engine,abi,functionName,args,blockNumber});
let stopped=false;process.on('SIGTERM',()=>{stopped=true});process.on('SIGINT',()=>{stopped=true});
const durationSeconds=Number(process.env.EROS_SERVICE_DURATION_SECONDS ?? '4800');
if(!Number.isInteger(durationSeconds)||durationSeconds<60||durationSeconds>86400)throw Error('INVALID_SERVICE_DURATION');
const end=Date.now()+durationSeconds*1000;
const owners=[['buy',privateKeyToAccount(roles.MAKER_BUY_PRIVATE_KEY)],['sell',privateKeyToAccount(roles.MAKER_SELL_PRIVATE_KEY)]];
async function reconcile(){
 if(!state.pending)return;
 const p=state.pending;
 let receipt=await client.getTransactionReceipt({hash:p.hash}).catch(()=>null);
 if(!receipt){await client.sendRawTransaction({serializedTransaction:p.raw});receipt=await client.waitForTransactionReceipt({hash:p.hash});}
 if(receipt.status!=='success')throw new Error('Maker transaction reverted; inspect journal');
 while((await client.getBlock({blockTag:'finalized'})).number<receipt.blockNumber)await new Promise(r=>setTimeout(r,1000));
 if((await client.getBlock({blockNumber:receipt.blockNumber})).hash!==receipt.blockHash)throw new Error('Maker receipt noncanonical');
 const events=receipt.logs.filter(l=>l.address.toLowerCase()===m.engine.toLowerCase()).flatMap(l=>{try{return[decodeEventLog({abi,data:l.data,topics:l.topics})]}catch{return[]}});
 if(!events.some(e=>e.eventName==='OrderPlaced')){
  const rejected=events.find(e=>e.eventName==='OrderRejected');
  if(!rejected)throw new Error('Successful transaction has neither an order nor a rejection; inspect maker journal');
  state.rejected??=[];state.rejected.push({...p,reason:Number(rejected.args.reason),block:receipt.blockNumber.toString()});
  delete state.pending;save();log({rejected:true,hash:p.hash,side:p.side,reason:Number(rejected.args.reason)});return;
 }
 state.completed.push({side:p.side,epoch:p.epoch,hash:p.hash,tick:p.tick});delete state.pending;save();log({finalized:true,...state.completed.at(-1)});
}
if(await client.getChainId()!==10143)throw new Error('Wrong chain');
if((await client.call({data:'0x73'+m.engine.slice(2)+'3f60005260206000f3',blockTag:'finalized'})).data!==m.engineCodeHash)throw new Error('Engine runtime mismatch');
log({started:true,pid:process.pid,scope:'bounded independently-funded testnet makers',durationSeconds});
while(!stopped&&Date.now()<end){
 await reconcile();
 const block=await client.getBlock(),risk=await read('marketRiskView',[],block.number),epoch=await read('marketOrderEpoch',[],block.number);
 const readinessDelay=makerReadinessDelay(risk);
 if(readinessDelay){log({waiting:'fresh index and ready accounting',indexAvailable:risk.indexAvailable,accountingState:risk.accountingState,pendingWork:risk.pendingWork,retryAfterMs:readinessDelay});await new Promise(r=>setTimeout(r,readinessDelay));continue;}
 for(const [side,account] of owners){
  if(state.completed.some(v=>v.epoch===epoch.toString()&&v.side===side))continue;
  if((state.rejected??[]).filter(v=>v.epoch===epoch.toString()&&v.side===side).length>=3)throw new Error('Maker rejection budget exhausted');
  const current=await client.getBlock(),source=await read('sourceState',[sourceId],current.number);
  if(current.timestamp-source.lastObservedAt>18n){log({side,waiting:'fresh source headroom before order preparation'});continue;}
  const tick=Number(risk.indexWad/10n**15n)+(side==='buy'?-10:10),size=2_000_000n;
  if(tick<1||tick>999)throw new Error('Event price outside maker range');
  const id=await read('participantId',[account.address],block.number);
  const preview=await read('previewOrder',[id,side==='buy'?0:1,tick,size,false],block.number);
  if(preview.rejection||preview.acceptedCapLots<size){log({side,admitted:false,rejection:preview.rejection,cap:preview.acceptedCapLots});continue;}
  const args=[{kind:2,isBuy:side==='buy',reduceOnly:false,tick,size,maxFills:8,expiryBlock:0}];
  await client.simulateContract({address:m.engine,abi,functionName:'placeOrder',args,account:account.address,blockNumber:block.number});
  const gas=(await client.estimateContractGas({address:m.engine,abi,functionName:'placeOrder',args,account:account.address,blockNumber:block.number}))*125n/100n+10000n;
  if(gas>2_000_000n)throw new Error('Maker gas exceeds policy');
  const [latest,pending]=await Promise.all(['latest','pending'].map(blockTag=>client.getTransactionCount({address:account.address,blockTag})));
  if(latest!==pending)throw new Error('Untracked maker nonce');
  if((await client.getBlock({blockNumber:block.number})).hash!==block.hash)throw new Error('Preview noncanonical');
  const wallet=createWalletClient({account,chain:monadTestnet,transport:http(rpc)});
  const req=await wallet.prepareTransactionRequest({to:m.engine,data:encodeFunctionData({abi,functionName:'placeOrder',args}),gas,nonce:latest,maxFeePerGas:150_000_000_000n,maxPriorityFeePerGas:2_000_000_000n});
  const raw=await wallet.signTransaction(req);state.pending={hash:keccak256(raw),raw,side,epoch:epoch.toString(),tick};save();await reconcile();
 }
 await new Promise(r=>setTimeout(r,3000));
}
await reconcile();log({stopped:true});
