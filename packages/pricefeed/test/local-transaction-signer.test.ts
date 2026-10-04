import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { keccak256, parseTransaction, recoverTransactionAddress, type Hex, type TransactionSerialized } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { LocalTransactionSigner, type RelayTransactionRequest } from '../src/local-transaction-signer.js';

const request:RelayTransactionRequest={to:'0x1111111111111111111111111111111111111111',data:'0x1234',nonce:0n,gas:100000n,maxFeePerGas:100n,maxPriorityFeePerGas:1n};
function setup(){const dir=mkdtempSync(join(tmpdir(),'pricefeed-tx-signer-')),path=join(dir,'transactions.sqlite');return {dir,path,close:()=>rmSync(dir,{recursive:true,force:true})};}
test('durable transaction signer reopens exact raw bytes and identity without sending',async()=>{
  const s=setup();let signer=new LocalTransactionSigner(s.path,true);try{
    const id=signer.id,raw=await signer.sign(request);signer.close();signer=new LocalTransactionSigner(s.path);
    assert.equal(signer.id,id);assert.equal(await signer.sign(request),raw);
    const t=parseTransaction(raw);assert.equal(t.chainId,31337);assert.equal(t.nonce,0);assert.equal(t.value??0n,0n);
    assert.equal((await recoverTransactionAddress({serializedTransaction:raw as TransactionSerialized})).toLowerCase(),signer.address.toLowerCase());
    await signer.reconcile([{request,raw}]);
    const db=new DatabaseSync(s.path,{readOnly:true});try{assert.equal(db.prepare('SELECT tx_hash FROM transaction_reservations').get()!.tx_hash,keccak256(raw));}finally{db.close();}
  }finally{signer.close();s.close();}
});
test('the same nonce cannot sign different calldata, destination or gas/fee terms',async()=>{
  const s=setup(),signer=new LocalTransactionSigner(s.path,true);try{
    const raw=await signer.sign(request);
    for(const delta of [{data:'0xabcd' as Hex},{to:'0x2222222222222222222222222222222222222222'},{gas:99999n},{maxFeePerGas:101n},{maxPriorityFeePerGas:2n}])
      await assert.rejects(signer.sign({...request,...delta}),/NONCE_CONFLICT/);
    assert.equal(await signer.sign(request),raw);
  }finally{signer.close();s.close();}
});
test('signer reconciliation rejects missing, conflicting and duplicate relay reservations',async()=>{
  const s=setup(),signer=new LocalTransactionSigner(s.path,true);try{
    const raw=await signer.sign(request);
    await assert.rejects(signer.reconcile([]),/AHEAD_OR_MISMATCH/);
    await assert.rejects(signer.reconcile([{request:{...request,gas:99999n},raw:null}]),/AHEAD_OR_MISMATCH/);
    await assert.rejects(signer.reconcile([{request,raw:'0xdead'}]),/AHEAD_OR_MISMATCH/);
    await assert.rejects(signer.reconcile([{request,raw},{request,raw}]),/RELAY_MISMATCH/);
    await signer.reconcile([{request,raw:null}]); // crashed before relay retained raw bytes
  }finally{signer.close();s.close();}
});
test('restored empty signer journal cannot approve raw transactions already retained by relay',async()=>{
  const s=setup(),signer=new LocalTransactionSigner(s.path,true);try{
    const raw=await privateKeyToAccount(('0x'+'22'.repeat(32)) as Hex).signTransaction({type:'eip1559',chainId:31337,
      ...request,to:request.to as Hex,nonce:0,value:0n});
    await assert.rejects(signer.reconcile([{request,raw}]),/BEHIND_RELAY/);
    await signer.reconcile([{request,raw:null}]); // reservation not yet given to signer
  }finally{signer.close();s.close();}
});
test('missing journal requires explicit creation and metadata identity cannot change',()=>{
  const s=setup();try{
    assert.throws(()=>new LocalTransactionSigner(s.path),/JOURNAL_MISSING/);
    const signer=new LocalTransactionSigner(s.path,true);signer.close();
    const db=new DatabaseSync(s.path);db.prepare('UPDATE transaction_signer SET chain_id=?').run('143');db.close();
    assert.throws(()=>new LocalTransactionSigner(s.path),/IDENTITY_MISMATCH/);
  }finally{s.close();}
});
test('modified transaction bytes or checksum fail reopening',async()=>{
  const s=setup(),signer=new LocalTransactionSigner(s.path,true);try{
    await signer.sign(request);signer.close();
    const db=new DatabaseSync(s.path);db.prepare('UPDATE transaction_reservations SET raw=?').run('0xdead');db.close();
    assert.throws(()=>new LocalTransactionSigner(s.path),/JOURNAL_INTEGRITY/);
  }finally{s.close();}
});
test('a checksummed transaction signed by a different key fails signer recovery validation',async()=>{
  const s=setup(),signer=new LocalTransactionSigner(s.path,true);try{
    await signer.sign(request);
    const raw=await privateKeyToAccount(('0x'+'33'.repeat(32)) as Hex).signTransaction({type:'eip1559',chainId:31337,
      ...request,to:request.to as Hex,nonce:0,value:0n});
    const db=new DatabaseSync(s.path),body=String(db.prepare('SELECT request FROM transaction_reservations').get()!.request),hash=keccak256(raw);
    db.prepare('UPDATE transaction_reservations SET raw=?,tx_hash=?,sha256=?').run(raw,hash,createHash('sha256').update(`${body}:${raw}:${hash}`).digest('hex'));db.close();
    await assert.rejects(signer.reconcile([{request,raw}]),/JOURNAL_INTEGRITY/);
    await assert.rejects(signer.sign(request),/JOURNAL_INTEGRITY/);
  }finally{signer.close();s.close();}
});
test('bad nonce, zero gas, fees and malformed calldata allocate no reservation',async()=>{
  const s=setup(),signer=new LocalTransactionSigner(s.path,true);try{
    for(const delta of [{nonce:-1n},{nonce:BigInt(Number.MAX_SAFE_INTEGER)+1n},{gas:0n},{maxFeePerGas:0n},{maxPriorityFeePerGas:101n},{data:'0x123' as Hex}])
      await assert.rejects(signer.sign({...request,...delta}),/BAD_TRANSACTION_REQUEST/);
    await signer.reconcile([]);
  }finally{signer.close();s.close();}
});
test('concurrent identical requests retain one immutable transaction reservation',async()=>{
  const s=setup(),signer=new LocalTransactionSigner(s.path,true);try{
    const raws=await Promise.all([signer.sign(request),signer.sign(request)]);assert.equal(raws[0],raws[1]);
    const db=new DatabaseSync(s.path,{readOnly:true});try{assert.equal(db.prepare('SELECT count(*) AS n FROM transaction_reservations').get()!.n,1);}finally{db.close();}
  }finally{signer.close();s.close();}
});
