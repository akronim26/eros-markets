import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { generatePrivateKey } from 'viem/accounts';
import type { Hex } from 'viem';
import { createTestnetKey, loadTestnetKey, testnetJournalPath } from '../src/monad-keys.js';

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
test('unsafe parent and linked secret files are rejected with fixed errors before unlock',()=>{
  const dir=mkdtempSync(join(tmpdir(),'monad-key-paths-')),keys=join(dir,'keys');mkdirSync(keys,{mode:0o700});
  try{
    const key=join(keys,'key'),password=join(keys,'password'),address=createTestnetKey(key,password);
    chmodSync(keys,0o755);
    assert.throws(()=>loadTestnetKey(key,password,address),{message:'PRIVATE_DIRECTORY_REQUIRED'});
    assert.throws(()=>createTestnetKey(join(keys,'new-key'),join(keys,'new-password')),{message:'PRIVATE_DIRECTORY_REQUIRED'});
    assert.equal(existsSync(join(keys,'new-password')),false);chmodSync(keys,0o700);
    const alias=join(dir,'alias');symlinkSync(keys,alias);
    assert.throws(()=>loadTestnetKey(join(alias,'key'),password,address),{message:'PRIVATE_DIRECTORY_REQUIRED'});
    const link=join(keys,'key-link');symlinkSync(key,link);
    assert.throws(()=>loadTestnetKey(link,password,address),{message:'PRIVATE_FILE_REQUIRED'});
    const hard=join(keys,'hard-password');linkSync(password,hard);
    assert.throws(()=>loadTestnetKey(key,password,address),{message:'PRIVATE_FILE_REQUIRED'});unlinkSync(hard);
    assert.equal(loadTestnetKey(key,password,address).address,address);
  }finally{rmSync(dir,{recursive:true,force:true});}
});
test('creation is exclusive, flushes owner-only files and cleans only its failed attempt',()=>{
  const dir=mkdtempSync(join(tmpdir(),'monad-key-create-'));try{
    const path=join(dir,'key'),password=join(dir,'password');
    assert.throws(()=>createTestnetKey(path,path),{message:'KEY_PATHS_MUST_DIFFER'});assert.equal(readdirSync(dir).length,0);
    // A dangling symlink passes existsSync but must still be rejected by exclusive/no-follow creation.
    symlinkSync(join(dir,'missing'),path);
    assert.throws(()=>createTestnetKey(path,password),{message:'KEY_CREATE_FAILED'});
    assert.equal(existsSync(password),false);assert.ok(readdirSync(dir).includes('key'));unlinkSync(path);
    const address=createTestnetKey(path,password);assert.equal(statSync(path).mode&0o777,0o600);assert.equal(statSync(password).mode&0o777,0o600);
    assert.equal(loadTestnetKey(path,password,address).address,address);
    assert.throws(()=>createTestnetKey(path,password),{message:'KEY_ALREADY_EXISTS'});
  }finally{rmSync(dir,{recursive:true,force:true});}
});
test('journal paths reject symlink/hardlink/WAL aliases and missing restore files without creating anything',()=>{
  const dir=mkdtempSync(join(tmpdir(),'monad-journal-paths-'));try{
    const path=join(dir,'signer.sqlite');assert.throws(()=>testnetJournalPath(path,false),{message:'TESTNET_JOURNAL_MISSING'});
    assert.equal(testnetJournalPath(path,true),path);assert.equal(readdirSync(dir).length,0);
    writeFileSync(path+'-wal','orphan',{mode:0o600});
    assert.throws(()=>testnetJournalPath(path,true),{message:'TESTNET_JOURNAL_ORPHANED_SIDECAR'});unlinkSync(path+'-wal');
    writeFileSync(path,'fixture',{mode:0o600});assert.equal(testnetJournalPath(path,false),path);
    const alias=join(dir,'alias');linkSync(path,alias);
    assert.throws(()=>testnetJournalPath(path,false),{message:'TESTNET_PRIVATE_FILE_REQUIRED'});unlinkSync(alias);
    symlinkSync(path,path+'-wal');assert.throws(()=>testnetJournalPath(path,false),{message:'TESTNET_PRIVATE_FILE_REQUIRED'});unlinkSync(path+'-wal');
    symlinkSync(path,alias);assert.throws(()=>testnetJournalPath(alias,false),{message:'TESTNET_PRIVATE_FILE_REQUIRED'});
  }finally{rmSync(dir,{recursive:true,force:true});}
});
