import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parseEnv } from 'node:util'
import type { Hex } from 'viem'
import { artifact, atomicWrite, client } from './fresh-testnet'
import { manifestSchema, binding } from '../../services/market-ops/src/schema'
import { viemTransport } from '../../services/market-ops/src/chain'
import { Operations, type Command } from '../../services/market-ops/src/operations'
import { FileStore } from '../../services/market-ops/src/store'

const [mode,rootInput,action]=process.argv.slice(2),root=resolve(rootInput??'')
try {
 const base=JSON.parse(readFileSync(resolve(root,'base-plan.json'),'utf8'))
 const report=JSON.parse(readFileSync(resolve(root,'market-v2/market-verification.json'),'utf8'))
 if(!report.passed||report.publicTransactions!==7)throw new Error('VERIFIED_PUBLIC_MARKET_REQUIRED')
 const m=report.manifest.markets[0],c=report.manifest.contracts,dir=resolve(root,'services')
 mkdirSync(dir,{recursive:true,mode:0o700})
 const file=resolve(dir,'market-ops.json')
 if(mode==='prepare') {
  const pc=client('https://testnet-rpc.monad.xyz').public,block=await pc.getBlock()
  const estimate=await pc.estimateContractGas({address:m.engine,abi:artifact('RegistryBookRiskEngine').abi,functionName:'samplePerp',account:base.roles.KEEPER,blockNumber:block.number})
  const limit=(estimate*120n+99n)/100n+10000n
  if(limit>30000000n)throw new Error('SAMPLE_GAS_CAP_EXCEEDED')
  const raw={chainId:10143,engine:m.engine,engineCodeHash:m.codehash,listingHash:m.listingHash,marketId:m.marketId,
   oracle:c.ResolutionOracle.address,oracleCodeHash:c.ResolutionOracle.codehash,sender:base.roles.KEEPER,sampleEveryBlocks:'30',
   rolloverHelper:{address:c.RolloverBatcher.address,codeHash:c.RolloverBatcher.codehash,maxPages:32,gasCeiling:30000000},gas:{samplePerp:Number(limit)}}
  await viemTransport(manifestSchema.parse(raw),'https://testnet-rpc.monad.xyz').snapshot()
  atomicWrite(file,raw);atomicWrite(resolve(dir,'market-ops-gas.json'),{block:block.number,blockHash:block.hash,samplePerp:{estimate,limit},scope:'current testnet state; liquidation and future settlement require separate measurements'})
  console.log(JSON.stringify({prepared:true,sampleGas:limit.toString(),helper:'bounded adaptive estimate'}))
 }else if(mode==='tick') {
  if(!['sample','rollover','liquidate'].includes(action))throw new Error('INVALID_OPERATION')
  const manifest=manifestSchema.parse(JSON.parse(readFileSync(file,'utf8')))
  const broadcast=process.argv.includes('--broadcast')
  const key=broadcast?parseEnv(readFileSync(resolve(root,'roles.env'),'utf8')).KEEPER_PRIVATE_KEY as Hex:undefined
  const store=new FileStore(resolve(dir,'market-ops-journal.json'),binding(manifest))
  try {
   const operations=new Operations(manifest,viemTransport(manifest,'https://testnet-rpc.monad.xyz',key),store)
   console.log(JSON.stringify(await operations.tick({action} as Command,broadcast)))
  }finally{store.close()}
 }else throw new Error('UNKNOWN_COMMAND')
}catch(error){const e=error as Error;console.error(/^[A-Z][A-Z0-9_]+(?::[^\s]*)?$/.test(e.message)?e.message:e.name);process.exitCode=1}
