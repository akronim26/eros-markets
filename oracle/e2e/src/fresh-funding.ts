/** Fixed public testnet operator funding plan; journaled and finalized before reuse. */
import { readFileSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'
import { parseEther, keccak256, stringToHex } from 'viem'
import { atomicWrite, client, executePlan, type Plan } from './fresh-testnet'
const directory=resolve(process.argv[2]??''),command=process.argv[3],rpc=process.argv[4]??'https://testnet-rpc.monad.xyz'
const json=(v:unknown)=>JSON.stringify(v,(_,x)=>typeof x==='bigint'?x.toString():x,2)+'\n'
try {
 const base=JSON.parse(readFileSync(resolve(directory,'base-plan.json'),'utf8')) as Plan
 const file=resolve(directory,'funding-plan.json')
 if(command==='prepare') {
  if(existsSync(file))throw new Error('FUNDING_PLAN_EXISTS')
  const pc=client('https://testnet-rpc.monad.xyz').public
  const nonce=await pc.getTransactionCount({address:base.deployer,blockTag:'pending'})
  if(nonce!==await pc.getTransactionCount({address:base.deployer,blockTag:'latest'}))throw new Error('PENDING_DEPLOYER_TRANSACTION')
  const allocation={PUBLISHER:'1.5',KEEPER:'0.75',MAKER_BUY:'0.35',MAKER_SELL:'0.35'}
  const plan:Plan={...base,schema:'eros-testnet-funding/1',startNonce:nonce,maxTotalGasCostWei:parseEther('3.1').toString(),
   steps:Object.entries(allocation).map(([role,amount],i)=>({name:`fund:${role}`,nonce:nonce+i,to:base.roles[role],data:'0x',valueWei:parseEther(amount).toString()}))}
  atomicWrite(file,plan)
  console.log(JSON.stringify({prepared:true,totalMON:'2.95',roles:Object.keys(allocation)}))
 } else if(command==='rehearse'||command==='broadcast') {
  const plan=JSON.parse(readFileSync(file,'utf8')) as Plan
  if(command==='broadcast') {
   const rehearsal=JSON.parse(readFileSync(resolve(directory,'funding-rehearsal-journal.json'),'utf8'))
   if(rehearsal.status!=='passed'||rehearsal.planHash!==keccak256(stringToHex(json(plan))))throw new Error('PASSING_REHEARSAL_REQUIRED')
  }
  const lock=resolve(directory,'execution.lock');mkdirSync(lock)
  try {await executePlan(plan,directory,rpc,command==='broadcast','funding',async(p,pc,j)=>{
   const block=await pc.getBlock({blockTag:j.broadcast?'finalized':'latest'})
   const balances=await Promise.all(p.steps.map(async s=>({address:s.to,balance:(await pc.getBalance({address:s.to!,blockNumber:block.number})).toString()})))
   if(balances.some((b,i)=>BigInt(b.balance)<BigInt(p.steps[i].valueWei!)))throw new Error('FUNDING_BALANCE_MISMATCH')
   return {passed:true,publicTransactions:j.broadcast?p.steps.length:0,balances}
  })}finally{rmSync(lock,{recursive:true})}
 }else throw new Error('UNKNOWN_COMMAND')
}catch(error){const e=error as Error;console.error(/^[A-Z][A-Z0-9_]+(?::[^\s]*)?$/.test(e.message)?e.message:e.name);process.exitCode=1}
