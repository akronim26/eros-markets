import { createTestIndexer } from 'envio'
import { expect, it } from 'vitest'
import { AFTER_REPLAY_BLOCK, fixtureAddress } from './replay'
const engine=fixtureAddress('TradingEngine')
const owner='0x1111111111111111111111111111111111111111'
const hash=`0x${'ab'.repeat(32)}`
it('persists order lifecycle with trader identity and exact accounting amounts',async()=>{
 const indexer=createTestIndexer()
 const base={contract:'TradingEngine',srcAddress:engine,block:{number:AFTER_REPLAY_BLOCK,timestamp:1791111111,hash},transaction:{hash,from:owner}}
 await indexer.process({chains:{10143:{simulate:[
  {...base,event:'AccountRegistered',logIndex:0,params:{owner,index:6n}},
  {...base,event:'CashAllocated',logIndex:1,params:{owner,atoms:100000000n,cashQ:100000000000000000000000000n}},
  {...base,event:'OrderPlaced',logIndex:2,params:{id:33554441n,trader:7n,tick:650n,size:1000n,flags:5n,expiryBlock:0n}},
  {...base,event:'Fill',logIndex:3,params:{makerOrder:33554441n,maker:7n,taker:8n,tick:650n,size:400n,makerFeeQ:123n,takerFeeQ:456n}},
  {...base,event:'OrderCancelled',logIndex:4,params:{id:33554441n,size:600n,reason:0n}},
  {...base,event:'PairReduction',logIndex:5,params:{target:7n,partner:8n,lots:100n,tick:650n,feeTargetQ:31n,feePartnerQ:37n}},
 ] as never}}})
 const rows=await indexer.TradingEvent.getAll()
 expect(rows).toHaveLength(6)
 expect(rows.find(x=>x.kind==='OrderCancelled')).toMatchObject({engine,trader:7n,orderId:33554441n})
 expect(JSON.parse(rows.find(x=>x.kind==='Fill')!.payload)).toMatchObject({size:'400',makerFeeQ:'123',takerFeeQ:'456'})
 expect(rows.find(x=>x.kind==='PairReduction')).toMatchObject({trader:7n,maker:8n})
 expect(await indexer.TradingRegistration.getAll()).toMatchObject([{engine,owner,trader:7n}])
})
