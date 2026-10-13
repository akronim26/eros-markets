import assert from 'node:assert/strict';
import { test } from 'node:test';
import { monadSubmissionRpc } from '../src/monad-rpc.js';

test('submission nonce and simulation remain on writer while missing receipts can use a read fallback',async()=>{
  const oldFetch=globalThis.fetch,previous=process.env.MONAD_READ_FALLBACK_URLS;
  process.env.MONAD_READ_FALLBACK_URLS='https://submission-backup.invalid';
  const calls:{host:string;method:string;params:unknown[]}[]=[];
  globalThis.fetch=async(input,init)=>{
    const host=new URL(String(input)).hostname,body=JSON.parse(String(init?.body));
    const respond=(r:{id:number;method:string;params:unknown[]})=>{
      calls.push({host,method:r.method,params:r.params});
      let result:unknown;
      if(r.method==='eth_chainId')result='0x279f';
      else if(r.method==='eth_getBlockByNumber')result={number:'0xa',hash:'0x'+'ab'.repeat(32),
        timestamp:'0x'+Math.floor(Date.now()/1000).toString(16),transactions:[]};
      else if(r.method==='eth_getTransactionCount')result='0x7';
      else if(r.method==='eth_estimateGas')result='0x5208';
      else if(r.method==='eth_call')result='0x';
      else if(r.method==='eth_getTransactionReceipt'){
        if(host==='submission-writer.invalid')return {jsonrpc:'2.0',id:r.id,error:{code:-32005,message:'rate limit'}};
        result=null;
      }else assert.fail('Unexpected method '+r.method);
      return {jsonrpc:'2.0',id:r.id,result};
    };
    return Response.json(Array.isArray(body)?body.map(respond):respond(body));
  };
  try{
    const rpc=monadSubmissionRpc('https://submission-writer.invalid');
    const address='0x'+'11'.repeat(20) as `0x${string}`;
    assert.equal(await rpc.nonce(address),7n);
    assert.equal(await rpc.simulate(address,address,'0x',30000n),21000n);
    assert.equal(calls.some(c=>c.host==='submission-backup.invalid'),false);
    assert.equal(await rpc.receipt('0x'+'22'.repeat(32) as `0x${string}`),null);
    assert.ok(calls.some(c=>c.host==='submission-backup.invalid'&&c.method==='eth_getTransactionReceipt'));
    assert.ok(calls.filter(c=>['eth_getTransactionCount','eth_estimateGas','eth_call'].includes(c.method))
      .every(c=>c.host==='submission-writer.invalid'&&c.params[1]==='pending'));
  }finally{globalThis.fetch=oldFetch;if(previous===undefined)delete process.env.MONAD_READ_FALLBACK_URLS;else process.env.MONAD_READ_FALLBACK_URLS=previous;}
});
