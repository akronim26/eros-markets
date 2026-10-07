/** Two independent, generated testnet owners exercise the public SDK custody sequence. */
import { readFileSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'
import { parseEnv } from 'node:util'
import { encodeFunctionData, parseEther, keccak256, stringToHex, type Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { createTraderClient, transactionData } from '../../packages/oracle-sdk/src/trading'
import { toPublicManifest } from '../../packages/oracle-sdk/src/trading-manifest'
import { artifact, atomicWrite, client, executePlan, type Plan, type Step } from './fresh-testnet'
const directory=resolve(process.argv[2]??''), rawCommand=process.argv[3], role=process.argv[4], rpc=process.argv[5]??process.env.MONAD_TESTNET_RPC??'https://testnet-rpc.monad.xyz'
const fundOnly=rawCommand.endsWith('-funding'),command=rawCommand.replace(/-funding$/,'')
const json=(v:unknown)=>JSON.stringify(v,(_,x)=>typeof x==='bigint'?x.toString():x,2)+'\n'
try {
 if(!['MAKER_BUY','MAKER_SELL'].includes(role))throw new Error('KNOWN_OWNER_ROLE_REQUIRED')
 const base=JSON.parse(readFileSync(resolve(directory,'base-plan.json'),'utf8')) as Plan
 const marketDirectory=existsSync(resolve(directory,'market-verification.json'))?directory:resolve(directory,'market-v2')
 const manifest=toPublicManifest(JSON.parse(readFileSync(resolve(marketDirectory,'market-verification.json'),'utf8')).manifest)
 const owner=base.roles[role],sdk=createTraderClient(manifest,'polymarket-demo',owner),engine=sdk.market.engine
 const phase=(role==='MAKER_BUY'?'owner-buy':'owner-sell')+(fundOnly?'-funding':''),file=resolve(directory,`${phase}-plan.json`)
 if(command==='prepare') {
  if(existsSync(file))throw new Error('OWNER_PLAN_EXISTS')
  const pc=client(process.env.MONAD_TESTNET_RPC??'https://testnet-rpc.monad.xyz').public
  const nonce=await pc.getTransactionCount({address:owner,blockTag:'pending'})
  if(nonce!==await pc.getTransactionCount({address:owner,blockTag:'latest'}))throw new Error('OWNER_PENDING_TRANSACTION')
  if(await pc.readContract({address:engine,abi:artifact('RegistryBookRiskEngine').abi,functionName:'participantId',args:[owner]})!==0)throw new Error('OWNER_ALREADY_REGISTERED')
  // The current external book is checked; these are explicitly testnet maker quotes, not an external price attestation.
  let tick=500
  if(!fundOnly) {
   const source=JSON.parse(readFileSync(resolve(marketDirectory,'source.json'),'utf8'))
   const book=await (await fetch(`https://clob.polymarket.com/book?token_id=${source.config.mapping.outcomeTokenId}`,{signal:AbortSignal.timeout(10000)})).json() as any
   const bid=Math.max(...book.bids.map((b:any)=>Number(b.price))),ask=Math.min(...book.asks.map((a:any)=>Number(a.price)))
   if(!(bid>0&&bid<=ask&&ask<1&&Date.now()-Number(book.timestamp)<30000))throw new Error('FRESH_SOURCE_BOOK_REQUIRED')
   tick=role==='MAKER_BUY'?Math.max(1,Math.floor(bid*1000)-10):Math.min(999,Math.ceil(ask*1000)+10)
  }
  const calls=[sdk.approve(2000_000000n),sdk.deposit(2000_000000n),sdk.allocate(2000_000000n),
   sdk.placeOrder({kind:2,isBuy:role==='MAKER_BUY',reduceOnly:false,tick,size:2000_000n,maxFills:8,expiryBlock:0})]
  if(fundOnly)calls.pop()
  const steps:Step[]=[{name:`${role}:faucet`,nonce,to:sdk.token,data:encodeFunctionData({abi:artifact('TestUSDC').abi,functionName:'mint',args:[owner,2500_000000n]})},
   ...calls.map((call,i)=>{const tx=transactionData(call);return {name:`${role}:${call.functionName}`,nonce:nonce+i+1,to:tx.to,data:tx.data}})]
  atomicWrite(file,{...base,schema:'eros-testnet-owner/1',deployer:owner,startNonce:nonce,maxTotalGasCostWei:parseEther('0.35').toString(),steps})
  console.log(JSON.stringify({prepared:true,owner,role,tick:fundOnly?null:tick,claims:fundOnly?0:2000,collateralTokens:2000}))
 } else if(command==='rehearse'||command==='broadcast') {
  const plan=JSON.parse(readFileSync(file,'utf8')) as Plan
  let signer
  if(command==='broadcast') {
   const rehearsal=JSON.parse(readFileSync(resolve(directory,`${phase}-rehearsal-journal.json`),'utf8'))
   if(rehearsal.status!=='passed'||rehearsal.planHash!==keccak256(stringToHex(json(plan))))throw new Error('PASSING_REHEARSAL_REQUIRED')
   signer=privateKeyToAccount(parseEnv(readFileSync(resolve(directory,'roles.env'),'utf8'))[`${role}_PRIVATE_KEY`] as Hex)
  }
  const lock=resolve(directory,'execution.lock');mkdirSync(lock)
  try {await executePlan(plan,directory,rpc,command==='broadcast',phase,async(p,pc,j)=>{
   const block=await pc.getBlock({blockTag:j.broadcast?'finalized':'latest'})
   const read=(functionName:string,args:unknown[]=[])=>pc.readContract({address:engine,abi:artifact('RegistryBookRiskEngine').abi,functionName,args,blockNumber:block.number}) as Promise<any>
   const participantId=await read('participantId',[owner]),account=await read('previewAccount',[participantId])
   const orderEvents=j.steps.at(-1).receipt.logs
   const {parseEventLogs}=await import('viem')
   const placed=parseEventLogs({abi:artifact('RegistryBookRiskEngine').abi,eventName:'OrderPlaced',logs:orderEvents})
   if(!participantId||account.cashQ!==2000n*10n**24n||(!fundOnly&&placed.length!==1))throw new Error('OWNER_FUNDING_OR_ORDER_FAILED')
   return {passed:true,owner,engine,block:block.number.toString(),participantId,account,orderId:fundOnly?null:(placed[0] as any).args.id,publicTransactions:j.broadcast?j.steps.length:0}
  },signer)}finally{rmSync(lock,{recursive:true})}
 }else throw new Error('UNKNOWN_COMMAND')
}catch(error){const e=error as Error;console.error(command==='prepare'?e.message:/^[A-Z][A-Z0-9_]+(?::[^\s]*)?$/.test(e.message)?e.message:e.name);process.exitCode=1}
