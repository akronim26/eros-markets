import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createReadPool, readPoolEndpoints, type PoolRequest } from '../src/read-pool.js';

const hash = '0x' + 'ab'.repeat(32);
function fixture() {
  let now = 1_000_000;
  const calls: {url:string;request:PoolRequest}[]=[];
  const changed = new Map<string, (request:PoolRequest)=>unknown|Promise<unknown>>();
  const fallback = (request:PoolRequest):unknown => request.method==='eth_chainId'?'0x279f'
    :request.method==='eth_getBlockByNumber'?{number:'0xa',hash,timestamp:'0x3e8'}:'0x2';
  const pool=createReadPool({endpoints:readPoolEndpoints('https://a.invalid','https://b.invalid','2,2'),chainId:10143,
    now:()=>now,request:async(url,request)=>{
      calls.push({url,request});return changed.has(url)?changed.get(url)!(request):fallback(request);
    }});
  return {pool,calls,changed,fallback,advance:(ms:number)=>{now+=ms;}};
}

test('pool spreads reads, probes providers and coalesces simultaneous identical requests',async()=>{
  const f=fixture();
  for(let i=0;i<4;i++)await f.pool.request({method:'eth_getBalance',params:[`0x${i}`,'latest']});
  assert.deepEqual(new Set(f.calls.filter(c=>c.request.method==='eth_getBalance').map(c=>c.url)),new Set(['https://a.invalid','https://b.invalid']));
  const before=f.calls.length;
  const requests=Array.from({length:20},()=>f.pool.request({method:'eth_getBalance',params:['0xabc','latest']}));
  assert.deepEqual(await Promise.all(requests),Array(20).fill('0x2'));
  assert.equal(f.calls.length-before,1);
  assert.ok(f.pool.status().every(s=>s.healthy&&s.inFlight===0));
});

test('wrong-chain, stale and missing explicit-block providers cannot supply reads',async()=>{
  for(const kind of ['chain','stale','explicit']){
    const f=fixture();
    f.changed.set('https://a.invalid',r=>{
      if(kind==='chain'&&r.method==='eth_chainId')return '0x1';
      if(kind==='stale'&&r.method==='eth_getBlockByNumber')return {number:'0xa',hash,timestamp:'0x1'};
      if(kind==='explicit'&&r.params?.[0]==='0xa')throw Object.assign(new Error('unsupported'),{code:-32601});
      return f.fallback(r);
    });
    assert.equal(await f.pool.request({method:'eth_getBalance',params:['0x1','latest']}),'0x2');
    assert.ok(f.pool.status()[0]!.cooling);
    assert.equal(f.calls.filter(c=>c.url==='https://a.invalid'&&c.request.method==='eth_getBalance').length,0);
  }
});

test('snapshot failover verifies the original block hash before contract reads',async()=>{
  const f=fixture();await f.pool.request({method:'eth_getBlockByNumber',params:['latest',false]});
  f.changed.set('https://a.invalid',r=>{
    if(r.method==='eth_call')throw Object.assign(new Error('throttled private URL'),{status:429});
    return f.fallback(r);
  });
  f.changed.set('https://b.invalid',r=>r.method==='eth_getBlockByNumber'?{number:'0xa',hash:'0x'+'cd'.repeat(32),timestamp:'0x3e8'}:f.fallback(r));
  await assert.rejects(f.pool.request({method:'eth_call',params:[{to:'0x1'},'0xa']}),/RPC_POOL_UNAVAILABLE/);
  assert.equal(f.calls.filter(c=>c.url==='https://b.invalid'&&c.request.method==='eth_call').length,0);
  f.advance(2100);f.changed.delete('https://b.invalid');
  assert.equal(await f.pool.request({method:'eth_call',params:[{to:'0x1'},'0xa']}),'0x2');
});

test('contract revert bytes are preserved and never retried against another provider',async()=>{
  const f=fixture(),error=Object.assign(new Error('execution reverted'),{code:3,data:'0x12345678'});
  f.changed.set('https://a.invalid',r=>{if(r.method==='eth_call')throw error;return f.fallback(r);});
  await assert.rejects(f.pool.request({method:'eth_call',params:[{to:'0x1'},'latest']}),e=>e===error);
  assert.equal(f.calls.some(c=>c.url==='https://b.invalid'),false);
});

test('a concurrent provider cooldown cannot turn another read\'s contract revert into failover',async()=>{
  const f=fixture(),error=Object.assign(new Error('execution reverted'),{code:3,data:'0x12345678'});
  await f.pool.request({method:'eth_getBlockByNumber',params:['latest',false]});
  let rejectRevert:(error:unknown)=>void=()=>{},entered:()=>void=()=>{};
  const started=new Promise<void>(resolve=>{entered=resolve;});
  f.changed.set('https://a.invalid',r=>{
    if(r.method!=='eth_call')return f.fallback(r);
    if((r.params?.[0] as {data:string}).data==='0x01')return new Promise((_resolve,reject)=>{rejectRevert=reject;entered();});
    throw Object.assign(new Error('throttled'),{status:429});
  });
  const first=f.pool.request({method:'eth_call',params:[{to:'0x1',data:'0x01'},'0xa']});
  const rejected=assert.rejects(first,e=>e===error);
  await started;
  await f.pool.request({method:'eth_call',params:[{to:'0x1',data:'0x02'},'0xa']});
  rejectRevert(error);await rejected;
  assert.equal(f.calls.filter(c=>c.url==='https://b.invalid'&&c.request.method==='eth_call'
    &&(c.request.params?.[0] as {data:string}).data==='0x01').length,0);
});

test('pool queues a wide snapshot within provider capacity and does not poll every provider per read',async()=>{
  const f=fixture();let active=0,maximum=0;
  const slow=async(r:PoolRequest)=>{
    if(r.method!=='eth_getCode')return f.fallback(r);
    active++;maximum=Math.max(maximum,active);
    await new Promise(resolve=>setTimeout(resolve,5));active--;return '0x6000';
  };
  f.changed.set('https://a.invalid',slow);f.changed.set('https://b.invalid',slow);
  const results=await Promise.all(Array.from({length:12},(_,i)=>f.pool.request({method:'eth_getCode',params:[`0x${i}`,'latest']})));
  assert.equal(results.length,12);assert.ok(maximum<=4);assert.ok(maximum>=2);
  assert.equal(f.calls.filter(c=>c.request.method==='eth_chainId').length,2);
});

test('pool excludes writes, pending nonces and simulations and rejects unsafe endpoint configuration',async()=>{
  const f=fixture();
  for(const request of [{method:'eth_sendRawTransaction',params:['0x123']},
    {method:'eth_getTransactionCount',params:['0x1','pending']},
    {method:'eth_call',params:[{from:'0x1'},'latest']},
    {method:'eth_getBalance',params:['0x1','pending']}])await assert.rejects(f.pool.request(request),/RPC_POOL_READ_ONLY/);
  assert.equal(f.calls.length,0);
  assert.throws(()=>readPoolEndpoints('https://user:secret@a.invalid'),/MONAD_HTTPS_RPC_REQUIRED/);
  assert.throws(()=>readPoolEndpoints('https://a.invalid','https://b.invalid','1'),/RPC_POOL_INVALID_CAPACITY/);
});

test('finalized snapshots never move backwards when failover reaches a lagging canonical provider',async()=>{
  const f=fixture();
  const old={number:'0x9',hash:'0x'+'09'.repeat(32),timestamp:'0x3e7'};
  await f.pool.request({method:'eth_getBlockByNumber',params:['finalized',false]});
  f.changed.set('https://b.invalid',r=>r.method==='eth_getBlockByNumber'?old:f.fallback(r));
  const next=await f.pool.request({method:'eth_getBlockByNumber',params:['finalized',false]});
  assert.deepEqual(next,{number:'0xa',hash,timestamp:'0x3e8'});
  assert.ok(f.pool.status()[1]!.cooling);
  // Even when every provider is behind, do not return stale finality or erase the watermark.
  f.changed.set('https://a.invalid',r=>r.method==='eth_getBlockByNumber'?old:f.fallback(r));
  await assert.rejects(f.pool.request({method:'eth_getBlockByNumber',params:['finalized',false]}),/RPC_POOL_UNAVAILABLE/);
  f.advance(2100);f.changed.delete('https://a.invalid');
  assert.deepEqual(await f.pool.request({method:'eth_getBlockByNumber',params:['finalized',false]}),next);
});

test('a changed finalized block hash remains a consistency error rather than a lag retry',async()=>{
  const f=fixture();
  await f.pool.request({method:'eth_getBlockByNumber',params:['finalized',false]});
  f.changed.set('https://b.invalid',r=>r.method==='eth_getBlockByNumber'
    ?{number:'0xa',hash:'0x'+'cd'.repeat(32),timestamp:'0x3e8'}:f.fallback(r));
  await assert.rejects(f.pool.request({method:'eth_getBlockByNumber',params:['finalized',false]}),/RPC_POOL_BLOCK_CHANGED/);
});
