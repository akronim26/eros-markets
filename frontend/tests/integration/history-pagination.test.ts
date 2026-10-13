import assert from "node:assert/strict";
import { test } from "node:test";
import { readHistory, validatedEvents, type HistoryEvent, type indexerQuery } from "../../src/lib/history";
import { readIndexedMarketIds } from "../../src/lib/market-discovery";
const owner="0x1111111111111111111111111111111111111111",engine="0x2222222222222222222222222222222222222222";
const event=(id:number):HistoryEvent=>({id:String(id),engine:"",kind:"Deposit",block:1,logIndex:id,timestamp:"1000",txHash:`0x${"12".repeat(32)}`,payload:'{"atoms":"1"}'});
test("vault activity is paginated, sorted and deduplicated before history is called complete",async()=>{
 const offsets:number[]=[];
 const query=(async(q:string,v:Record<string,unknown>)=>{
  if(q.includes("_meta"))return {_meta:[{progressBlock:100,isReady:true}]};
  if(q.includes("CollateralTransfer")) { offsets.push(Number(v.vaultOffset));return {TradingEvent:v.vaultOffset===0?Array.from({length:1000},(_,i)=>event(i)):v.vaultOffset===1000?[event(999),event(1000)]:[],CollateralTransfer:[]}; }
  return {TradingEvent:[]};
 }) as typeof indexerQuery;
 const result=await readHistory(10143,engine,owner,1,100n,undefined,{vault:owner,token:engine},query);
 assert.deepEqual(offsets,[0,1000,1002]);assert.equal(result.complete,true);assert.equal(result.events.length,1001);
});
test("hitting the vault pagination limit leaves totals explicitly incomplete",async()=>{
 const query=(async(q:string,v:Record<string,unknown>)=>{
  if(q.includes("_meta"))return {_meta:[{progressBlock:100,isReady:true}]};
  return q.includes("CollateralTransfer")?{TradingEvent:Array.from({length:Number(v.vaultLimit)},(_,i)=>event(Number(v.vaultOffset)+i)),CollateralTransfer:[]}:{TradingEvent:[]};
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

test("indexed observation times cannot overflow chart dates or exceed their event time",()=>{
 for (const kind of ["ObservationAccepted", "PerpObservationRecorded"]) {
  const observation = (time: string | number, timestamp = "1000"): HistoryEvent => ({
   ...event(1), kind, timestamp, payload: JSON.stringify(kind === "ObservationAccepted"
    ? { observedAt: time, priceWad: "500000000000000000", depthValid: true }
    : { t: time, midWad: "500000000000000000", valid: true }),
  });
  for (const time of ["9".repeat(400), "9007199254740992", "8640000000001", "1001", 1001, -1, 1.5]) {
   assert.throws(() => validatedEvents([observation(time)], 100), /History returned/, `${kind}: ${time}`);
  }
  for (const time of ["0", "999", "1000", 1000]) {
   assert.equal(validatedEvents([observation(time)], 100).length, 1);
  }
  const maxDate = "8640000000000";
  assert.equal(validatedEvents([observation(maxDate, maxDate)], 100).length, 1);
  assert.ok(Number.isFinite(new Date(Number(maxDate) * 1000).getTime()));
 }
});

test("price history rejects foreign-engine rows and unexpected kinds without excluding vault history", async () => {
 const price: HistoryEvent = { ...event(3), engine, kind: "ObservationAccepted", payload: '{"observedAt":"999","priceWad":"500000000000000000","depthValid":true}' };
 const queryFor = (row: HistoryEvent) => (async(q: string) => {
  if(q.includes("_meta")) return {_meta:[{progressBlock:100,isReady:true}]};
  return {TradingEvent:[row]};
 }) as typeof indexerQuery;
 await assert.rejects(readHistory(10143,engine,undefined,undefined,100n,undefined,undefined,queryFor({...price,engine:owner})), /another market/);
 await assert.rejects(readHistory(10143,engine,undefined,undefined,100n,undefined,undefined,queryFor({...price,kind:"Deposit",payload:'{"atoms":"1"}'})), /event kind/);
 const result = await readHistory(10143,engine,undefined,undefined,100n,undefined,undefined,queryFor(price));
 assert.equal(result.prices.length,1);
 // Empty-engine vault events remain valid in their separate account-history scope.
 assert.equal(validatedEvents([event(1)],100).length,1);
});

test("server row caps do not truncate account history or differently capped vault lists", async () => {
 const account=Array.from({length:7},(_,i)=>event(i));
 const vault=Array.from({length:5},(_,i)=>event(100+i));
 const transfers=Array.from({length:11},(_,i)=>({...event(200+i),from:owner,to:engine,atoms:"1"}));
 const accountOffsets:number[]=[],vaultOffsets:number[]=[],transferOffsets:number[]=[];
 const query=(async(q:string,v:Record<string,unknown>)=>{
  if(q.includes("_meta"))return {_meta:[{progressBlock:100,isReady:true}]};
  if(q.includes("CollateralTransfer")) {
   const vo=Number(v.vaultOffset??v.offset),to=Number(v.transferOffset??v.offset);
   if(v.vaultLimit!==0)vaultOffsets.push(vo);
   if(v.transferLimit!==0)transferOffsets.push(to);
   return {TradingEvent:v.vaultLimit===0?[]:vault.slice(vo,vo+2),CollateralTransfer:v.transferLimit===0?[]:transfers.slice(to,to+3)};
  }
  if(!q.includes("$owner"))return {TradingEvent:[]};
  const offset=Number(v.offset);accountOffsets.push(offset);
  return {TradingEvent:account.slice(offset,offset+3)};
 }) as typeof indexerQuery;
 const result=await readHistory(10143,engine,owner,1,100n,undefined,{vault:owner,token:engine},query);
 assert.equal(result.events.length,23);
 assert.equal(result.complete,true);
 assert.deepEqual(accountOffsets,[0,3,6,7]);
 assert.deepEqual(vaultOffsets,[0,2,4,5]);
 assert.deepEqual(transferOffsets,[0,3,6,9,11]);
});

test("a capped server cannot exceed the account and transfer history bounds", async () => {
 const accountOffsets:number[]=[],transferOffsets:number[]=[];
 const query=(async(q:string,v:Record<string,unknown>)=>{
  if(q.includes("_meta"))return {_meta:[{progressBlock:100,isReady:true}]};
  if(q.includes("CollateralTransfer")) {
   const offset=Number(v.transferOffset);transferOffsets.push(offset);
   return {TradingEvent:[],CollateralTransfer:Array.from({length:Math.min(777,Number(v.transferLimit))},(_,i)=>({...event(30000+offset+i),from:owner,to:engine,atoms:"1"}))};
  }
  if(!q.includes("$owner"))return {TradingEvent:[]};
  const offset=Number(v.offset);accountOffsets.push(offset);
  return {TradingEvent:Array.from({length:Math.min(333,Number(v.limit))},(_,i)=>event(offset+i))};
 }) as typeof indexerQuery;
 const result=await readHistory(10143,engine,owner,1,100n,undefined,{vault:owner,token:engine},query);
 assert.equal(result.complete,false);
 assert.equal(result.events.length,40000);
 assert.equal(accountOffsets.at(-1),19980);
 assert.equal(transferOffsets.at(-1),19425);
});

test("market discovery consumes capped pages through an empty page", async () => {
 const ids=Array.from({length:7},(_,i)=>`0x${i.toString(16).padStart(64,"0")}` as const);
 const offsets:number[]=[];
 const query=(async(_q:string,v:Record<string,unknown>)=>{
  const offset=Number(v.offset);offsets.push(offset);
  return {Market:ids.slice(offset,offset+3).map(id=>({id}))};
 }) as typeof indexerQuery;
 assert.deepEqual(await readIndexedMarketIds(query),ids);
 assert.deepEqual(offsets,[0,3,6,7]);
});

test("market discovery retains its row limit when server caps do not divide it", async () => {
 let received=0;
 const query=(async(_q:string,v:Record<string,unknown>)=>{
  assert.equal(v.offset,received);
  const length=Math.min(333,Number(v.limit));received+=length;
  return {Market:Array.from({length},()=>({id:engine}))};
 }) as typeof indexerQuery;
 await assert.rejects(readIndexedMarketIds(query),/pagination limit/);
 assert.equal(received,100000);
});
