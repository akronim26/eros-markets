import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MarketStreamHints, MARKET_STREAM_URL, type StreamPolicy, type StreamSocket, type StreamView } from '../src/market-stream.js';
import { config } from './publication-fixture.js';

const policy:StreamPolicy={connectTimeoutMs:30,heartbeatMs:10,pongTimeoutMs:15,reconnectBaseMs:5,reconnectMaxMs:20,maxFrameBytes:1000,maxEvents:4};
const pause=(ms:number)=>new Promise<void>(resolve=>setTimeout(resolve,ms));
async function until(predicate:()=>boolean):Promise<void>{
  for(let i=0;i<100;i++){if(predicate())return;await pause(2);}assert.fail('fixture condition timed out');
}
class Socket extends EventTarget implements StreamSocket {
  sent:string[]=[];closed=false;autoPong=true;throwSend=false;
  oldMessage:EventListener|null=null;
  override addEventListener(type:string,listener:EventListener):void {
    if(type==='message')this.oldMessage=listener;super.addEventListener(type,listener);
  }
  send(data:string):void {
    if(this.throwSend)throw new Error('fixture send failed');this.sent.push(data);
    if(data==='PING'&&this.autoPong)queueMicrotask(()=>this.frame('PONG'));
  }
  close():void {this.closed=true;this.dispatchEvent(new Event('close'));}
  open():void {this.dispatchEvent(new Event('open'));}
  frame(data:unknown):void {this.dispatchEvent(new MessageEvent('message',{data}));}
}
function fixture(options:{open?:boolean;autoPong?:boolean;factoryFail?:boolean}={}){
  const hints:{key:string;generation:number;reason:string;resync:boolean}[]=[],sockets:Socket[]=[],states:StreamView[]=[];
  const workers=[config,{...config,key:'other',mapping:{...config.mapping,outcomeTokenId:'3',conditionId:'0x'+'ab'.repeat(32)}}].map(cfg=>({config:cfg,
    requestStreamRefresh:(generation:number,reason:string,resync:boolean)=>hints.push({key:cfg.key,generation,reason,resync})}));
  const stream=new MarketStreamHints(workers,policy,url=>{
    assert.equal(url,MARKET_STREAM_URL);if(options.factoryFail)throw new Error('private provider value');
    const socket=new Socket();socket.autoPong=options.autoPong??true;sockets.push(socket);
    if(options.open!==false)queueMicrotask(()=>socket.open());return socket;
  },view=>states.push(view),()=>1);
  const stop=new AbortController();return {stream,stop,hints,sockets,states,run:()=>stream.run(stop.signal)};
}
const event=(kind='book',overrides:Record<string,unknown>={})=>({event_type:kind,market:config.mapping.conditionId,
  asset_id:config.mapping.outcomeTokenId,timestamp:'9999999999999',...overrides});

test('public exact subscription and PING/PONG track transport only, with no heartbeat refresh',async()=>{
  const f=fixture(),run=f.run();try{
    await until(()=>f.stream.inspect().pongs>=2);
    assert.deepEqual(JSON.parse(f.sockets[0]!.sent[0]!),{assets_ids:[config.mapping.outcomeTokenId,'3'],type:'market',custom_feature_enabled:true});
    assert.equal(f.stream.inspect().acceptedEvents,0);
    assert.equal(f.hints.length,4,'only connect/open resync for two workers; PONG must not refresh books');
    assert.ok(f.hints.every(h=>h.resync));
    await assert.rejects(f.run(),/ALREADY_RUNNING/);
  }finally{f.stop.abort();await run;}
  assert.equal(f.stream.inspect().state,'STOPPED');assert.ok(f.sockets.every(s=>s.closed));
});
test('routes exact token AND condition, batches, nested price changes and lifecycle hints',async()=>{
  const f=fixture(),run=f.run();try{
    await until(()=>f.sockets[0]?.sent.length===1);const socket=f.sockets[0]!,before=f.hints.length;
    socket.frame(JSON.stringify([event(),event('last_trade_price'),event('best_bid_ask')]));
    socket.frame(JSON.stringify(event('price_change',{price_changes:[{asset_id:config.mapping.outcomeTokenId,price:'0.1',size:'0'},{asset_id:'3',size:'5'}]})));
    socket.frame(JSON.stringify(event('book',{market:'0x'+'ab'.repeat(32)})));
    socket.frame(JSON.stringify(event('book',{asset_id:'3'})));
    socket.frame(JSON.stringify({event_type:'future_schema',secret:'ignored'}));
    socket.frame(JSON.stringify(event('tick_size_change')));
    socket.frame(JSON.stringify(event('market_resolved',{assets_ids:[config.mapping.outcomeTokenId]})));
    socket.frame(JSON.stringify(event('new_market',{assets_ids:[config.mapping.outcomeTokenId]})));
    const added=f.hints.slice(before);assert.equal(added.length,7);assert.ok(added.every(h=>h.key===config.key));
    assert.equal(added.filter(h=>h.resync).length,3);assert.equal(f.stream.inspect().ignoredEvents,3);
    assert.equal(f.stream.inspect().acceptedEvents,7);assert.equal(f.stream.inspect().rejectedFrames,0);
    assert.ok(added.every(h=>!('timestamp' in h)&&!('price' in h)));
  }finally{f.stop.abort();await run;}
});
test('reconnect increments generation, ignores detached old callbacks and resubscribes',async()=>{
  const f=fixture(),run=f.run();try{
    await until(()=>f.sockets[0]?.sent.length===1);const old=f.sockets[0]!,oldCallback=old.oldMessage!;
    f.stream.requestReconnect();await until(()=>f.sockets[1]?.sent.length===1);
    const before=f.hints.length;oldCallback(new MessageEvent('message',{data:JSON.stringify(event())}));
    old.open();old.frame(JSON.stringify(event()));assert.equal(f.hints.length,before);
    f.sockets[1]!.frame(JSON.stringify(event()));assert.equal(f.hints.at(-1)!.generation,2);
    assert.equal(f.stream.inspect().connections,2);assert.ok(old.closed);
    assert.deepEqual(f.sockets[1]!.sent[0],old.sent[0]);assert.ok(f.hints.some(h=>h.reason==='STREAM_REQUESTED_RECONNECT'&&h.resync));
  }finally{f.stop.abort();await run;}
});
test('malformed, oversized, binary and excessive batches discard the entire generation',async()=>{
  for(const data of ['{broken','x'.repeat(1001),new Uint8Array([1]),JSON.stringify(Array(5).fill(event())),
    JSON.stringify([event(),{event_type:'book',market:config.mapping.conditionId,asset_id:12}]),
    JSON.stringify(event('price_change',{price_changes:[]}))]){
    const f=fixture(),run=f.run();try{
      await until(()=>f.sockets[0]?.sent.length===1);const accepted=f.stream.inspect().acceptedEvents;
      f.sockets[0]!.frame(data);assert.equal(f.stream.inspect().acceptedEvents,accepted);
      await until(()=>f.stream.inspect().rejectedFrames===1);assert.ok(f.sockets[0]!.closed);
      await until(()=>f.sockets[1]?.sent.length===1);assert.equal(f.stream.inspect().generation,2);
    }finally{f.stop.abort();await run;}
  }
});
test('missed PONG forces resync even while market messages continue',async()=>{
  const f=fixture({autoPong:false}),run=f.run();try{
    await until(()=>f.sockets[0]?.sent.includes('PING')===true);f.sockets[0]!.frame(JSON.stringify(event()));
    await until(()=>f.sockets.length>=2);assert.equal(f.stream.inspect().pongs,0);
    assert.ok(f.states.some(s=>s.reason==='STREAM_PONG_TIMEOUT'));assert.ok(f.sockets[0]!.closed);
  }finally{f.stop.abort();await run;}
});
test('connect timeout/factory failure back off with fixed errors; abort wakes connection and backoff',async()=>{
  for(const options of [{open:false},{factoryFail:true}]){
    const f=fixture(options),run=f.run();try{
      await until(()=>f.states.filter(s=>s.state==='BACKOFF').length>=2);
      assert.ok(f.states.every(s=>!JSON.stringify(s).includes('private provider value')));
      const generations=f.stream.inspect().generation;f.stop.abort();await run;await pause(30);
      assert.equal(f.stream.inspect().generation,generations);
    }finally{f.stop.abort();await run;}
  }
  const f=fixture({open:false}),run=f.run();f.stop.abort();await run;assert.ok(f.sockets[0]!.closed);
});
test('socket close, error and heartbeat send failure each trigger a new complete resync',async()=>{
  for(const failure of ['close','error','send']){
    const f=fixture(),run=f.run();try{
      await until(()=>f.sockets[0]?.sent.length===1);const socket=f.sockets[0]!;
      if(failure==='send')socket.throwSend=true;else socket.dispatchEvent(new Event(failure));
      await until(()=>f.sockets[1]?.sent.length===1);assert.ok(socket.closed);
      assert.ok(f.hints.filter(h=>h.generation===2).every(h=>h.resync));
    }finally{f.stop.abort();await run;}
  }
});
test('hint handler failure is fatal and does not disappear as a provider reconnect',async()=>{
  const socket=new Socket();let opened=false;
  const stream=new MarketStreamHints([{config,requestStreamRefresh:(_g,reason)=>{
    if(reason==='book')throw new Error('WRITER_FENCED');}}],policy,()=>{queueMicrotask(()=>socket.open());return socket;},view=>{opened=view.state==='CONNECTED';});
  const run=stream.run(new AbortController().signal);await until(()=>opened);socket.frame(JSON.stringify(event()));
  await assert.rejects(run,/WRITER_FENCED/);assert.ok(socket.closed);assert.equal(stream.inspect().state,'STOPPED');
});
test('invalid policies/identities and duplicate worker keys fail before any connection',()=>{
  const worker={config,requestStreamRefresh:()=>{}};
  for(const cfg of [{...policy,heartbeatMs:10001},{...policy,maxEvents:1001},{...policy,reconnectMaxMs:1},
    {...policy,maxFrameBytes:0}])assert.throws(()=>new MarketStreamHints([worker],cfg));
  assert.throws(()=>new MarketStreamHints([]));assert.throws(()=>new MarketStreamHints([worker,worker]));
  assert.throws(()=>new MarketStreamHints([{...worker,config:{...config,mapping:{...config.mapping,outcomeTokenId:'invalid'}}}]));
});
