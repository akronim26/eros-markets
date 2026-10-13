/** Owner-only release and withdrawal smoke check, separate from price-dependent order admission. */
import { readFileSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'
import { parseEnv } from 'node:util'
import { keccak256, stringToHex, type Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { createTraderClient, transactionData } from '../../packages/oracle-sdk/src/trading'
import { toPublicManifest } from '../../packages/oracle-sdk/src/trading-manifest'
import { RegistryBookRiskEngineAbi } from '../../packages/oracle-sdk/src/abi/RegistryBookRiskEngine'
import { atomicWrite, client, executePlan, type Plan } from './fresh-testnet'
const [command,input,rpcInput]=process.argv.slice(2),dir=resolve(input??''),rpc=rpcInput??'https://testnet-rpc.monad.xyz'
try {
 const base=JSON.parse(readFileSync(resolve(dir,'base-plan.json'),'utf8')) as Plan
 const manifest=toPublicManifest(JSON.parse(readFileSync(resolve(dir,'market-v2/market-verification.json'),'utf8')).manifest)
 const owner=base.roles.MAKER_BUY,sdk=createTraderClient(manifest,'polymarket-demo',owner),file=resolve(dir,'withdrawal-plan.json')
 if(command==='prepare') {
  if(existsSync(file))throw new Error('WITHDRAWAL_PLAN_EXISTS')
  const pc=client(rpc).public,nonce=await pc.getTransactionCount({address:owner,blockTag:'pending'})
  if(nonce!==4||await pc.getTransactionCount({address:owner,blockTag:'latest'})!==nonce)throw new Error('OWNER_NONCE_CHANGED')
  atomicWrite(file,{...base,schema:'eros-testnet-withdrawal/1',deployer:owner,startNonce:nonce,maxTotalGasCostWei:'100000000000000000',
   steps:[sdk.release(100_000000n),sdk.withdraw(100_000000n)].map((call,i)=>{const tx=transactionData(call);return {name:call.functionName,nonce:nonce+i,to:tx.to,data:tx.data}})})
 }else if(command==='rehearse'||command==='broadcast') {
  const plan=JSON.parse(readFileSync(file,'utf8')) as Plan
  let signer
  if(command==='broadcast') {
   const rehearsal=JSON.parse(readFileSync(resolve(dir,'withdrawal-rehearsal-journal.json'),'utf8'))
   if(rehearsal.status!=='passed'||rehearsal.planHash!==keccak256(stringToHex(JSON.stringify(plan,null,2)+'\n')))throw new Error('PASSING_REHEARSAL_REQUIRED')
   signer=privateKeyToAccount(parseEnv(readFileSync(resolve(dir,'roles.env'),'utf8')).MAKER_BUY_PRIVATE_KEY as Hex)
  }
  const lock=resolve(dir,'execution.lock');mkdirSync(lock)
  try {await executePlan(plan,dir,rpc,command==='broadcast','withdrawal',async(p,pc,j)=>{
   const block=await pc.getBlock({blockTag:j.broadcast?'finalized':'latest'})
   const participant=await pc.readContract({...sdk.participantId(),blockNumber:block.number})
   const [account,wallet,free]=await Promise.all([
    pc.readContract({address:sdk.market.engine,abi:RegistryBookRiskEngineAbi,functionName:'previewAccount',args:[participant],blockNumber:block.number}),
    pc.readContract({...sdk.walletBalance(),blockNumber:block.number}),pc.readContract({...sdk.freeBalance(),blockNumber:block.number}),
   ])
   if(account.cashQ!==1900n*10n**24n||wallet!==600_000000n||free!==0n)throw new Error('WITHDRAWAL_BALANCES_MISMATCH')
   return {passed:true,publicTransactions:j.broadcast?2:0,owner,engine:sdk.market.engine,block:block.number,marketCashQ:account.cashQ,walletAtoms:wallet,freeVaultAtoms:free}
  },signer)}finally{rmSync(lock,{recursive:true})}
 }else throw new Error('UNKNOWN_COMMAND')
}catch(error){const e=error as Error;console.error(/^[A-Z][A-Z0-9_]+(?::[^\s]*)?$/.test(e.message)?e.message:e.name);process.exitCode=1}
