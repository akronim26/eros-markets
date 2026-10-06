import assert from "node:assert/strict";
import { test } from "node:test";
import { readHistory, validatedEvents, type HistoryEvent, type indexerQuery } from "../../src/lib/history";
const owner="0x1111111111111111111111111111111111111111",engine="0x2222222222222222222222222222222222222222";
const event=(id:number):HistoryEvent=>({id:String(id),engine:"",kind:"Deposit",block:1,logIndex:id,timestamp:"1000",txHash:`0x${"12".repeat(32)}`,payload:'{"atoms":"1"}'});
test("vault activity is paginated, sorted and deduplicated before history is called complete",async()=>{
 const offsets:number[]=[];
 const query=(async(q:string,v:Record<string,unknown>)=>{
  if(q.includes("_meta"))return {_meta:[{progressBlock:100,isReady:true}]};
  if(q.includes("CollateralTransfer")) { offsets.push(Number(v.offset));return {TradingEvent:v.offset===0?Array.from({length:1000},(_,i)=>event(i)):v.offset===1000?[event(999),event(1000)]:[],CollateralTransfer:[]}; }
  return {TradingEvent:[]};
 }) as typeof indexerQuery;
 const result=await readHistory(10143,engine,owner,1,100n,undefined,{vault:owner,token:engine},query);
 assert.deepEqual(offsets,[0,1000]);assert.equal(result.complete,true);assert.equal(result.events.length,1001);
});
test("hitting the vault pagination limit leaves totals explicitly incomplete",async()=>{
 const query=(async(q:string,v:Record<string,unknown>)=>{
  if(q.includes("_meta"))return {_meta:[{progressBlock:100,isReady:true}]};
  return q.includes("CollateralTransfer")?{TradingEvent:Array.from({length:1000},(_,i)=>event(Number(v.offset)+i)),CollateralTransfer:[]}:{TradingEvent:[]};
 }) as typeof indexerQuery;
 const result=await readHistory(10143,engine,owner,1,100n,undefined,{vault:owner,token:engine},query);
 assert.equal(result.complete,false);assert.equal(result.events.length,20000);
});
test("malformed history is rejected before it can crash amount/date rendering or inflate totals",()=>{
 for(const e of [{...event(1),timestamp:"bad"},{...event(1),timestamp:"9999999999999999"},{...event(1),block:101},
 {...event(1),payload:"{"},{...event(1),payload:'{"atoms":"NaN"}'},{...event(1),kind:"Fill",payload:'{"size":"1","tick":1000}'}])
  assert.throws(()=>validatedEvents([e],100),/History returned/);
 assert.throws(()=>validatedEvents([event(1),{...event(1),payload:'{"atoms":"2"}'}],100),/conflicting/);
 assert.equal(validatedEvents([event(1),event(1)],100).length,1);
});
