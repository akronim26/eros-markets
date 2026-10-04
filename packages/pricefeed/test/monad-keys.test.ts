import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { generatePrivateKey } from 'viem/accounts';
import type { Hex } from 'viem';
import { createTestnetKey, loadTestnetKey } from '../src/monad-keys.js';

test('encrypted testnet keys reopen with the same identity and reject wrong pins, loose permissions and corrupt ciphertext',()=>{
  const dir=mkdtempSync(join(tmpdir(),'monad-keys-'));chmodSync(dir,0o700);
  try{
    const path=join(dir,'key.json'),password=join(dir,'password');
    const address=createTestnetKey(path,password);
    assert.equal(loadTestnetKey(path,password,address).address,address);
    assert.throws(()=>loadTestnetKey(path,password,'0x'+'01'.repeat(20)),/KEY_IDENTITY_MISMATCH/);
    chmodSync(password,0o644);assert.throws(()=>loadTestnetKey(path,password,address),/PRIVATE_FILE_REQUIRED/);chmodSync(password,0o600);
    writeFileSync(password,Buffer.alloc(32));assert.throws(()=>loadTestnetKey(path,password,address),/KEY_UNLOCK_FAILED/);
    assert.throws(()=>createTestnetKey(path,password),/KEY_ALREADY_EXISTS/);
  }finally{rmSync(dir,{recursive:true,force:true});}
});
test('public fixture signing keys cannot become testnet keys',()=>{
  const dir=mkdtempSync(join(tmpdir(),'monad-keys-'));chmodSync(dir,0o700);
  try{
    assert.throws(()=>createTestnetKey(join(dir,'key'),join(dir,'password'),('0x'+'11'.repeat(32)) as Hex),/PUBLIC_FIXTURE_KEY_FORBIDDEN/);
    const address=createTestnetKey(join(dir,'key'),join(dir,'password'),generatePrivateKey());
    assert.equal(loadTestnetKey(join(dir,'key'),join(dir,'password'),address).address,address);
  }finally{rmSync(dir,{recursive:true,force:true});}
});
