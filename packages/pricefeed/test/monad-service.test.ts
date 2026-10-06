import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseTestnetRunPolicy, runMonadTestnetService, testnetPublicationInterval } from '../src/monad-service.js';
import { config, reviewed } from './publication-fixture.js';

const raw={schemaVersion:'1',sender:'0x'+'12'.repeat(20),relay:{gasCap:'800000',maxFeePerGas:'150000000000',
  maxPriorityFeePerGas:'2000000000',maxCostWei:'120000000000000000',headroomMs:'5000',confirmations:'1',
  leaseMs:'120000',timeoutMs:10000,maxAttempts:3},budget:{maxTransactions:3,totalMaxCostWei:'360000000000000000'}};
test('testnet publication cadence is explicit and bounded without changing the default',()=>{
  assert.equal(testnetPublicationInterval(1000),20000);
  assert.equal(testnetPublicationInterval(1000,5000),5000);
  assert.equal(testnetPublicationInterval(25000),25000);
  for(const interval of [0,999,30001,NaN,Infinity,1500.5])
    assert.throws(()=>testnetPublicationInterval(1000,interval),/BAD_TESTNET_PUBLICATION_INTERVAL/);
  assert.throws(()=>testnetPublicationInterval(5000,1000),/BAD_TESTNET_PUBLICATION_INTERVAL/);
});
test('testnet pilot policy rejects unsafe ceilings, latest-style confirmation counts and missing limits',()=>{
  const parsed=parseTestnetRunPolicy(raw);assert.equal(parsed.budget.totalMaxCostWei,360000000000000000n);
  assert.equal(parseTestnetRunPolicy({...raw,relay:{...raw.relay,gasSafetyMarginBps:'1000'}}).relay.gasSafetyMarginBps,1000n);
  for(const value of [{...raw,budget:{...raw.budget,maxTransactions:0}},
    {...raw,relay:{...raw.relay,confirmations:'2'}},{...raw,relay:{...raw.relay,maxFeePerGas:'0'}},
    {...raw,relay:{...raw.relay,maxPriorityFeePerGas:'150000000001'}},
    {...raw,budget:{...raw.budget,totalMaxCostWei:'1'}},
    {...raw,relay:{...raw.relay,gasSafetyMarginBps:'0'}},
    {...raw,relay:{...raw.relay,gasSafetyMarginBps:'5001'}}])assert.throws(()=>parseTestnetRunPolicy(value));
});
test('testnet service refuses another chain before creating journals or accessing keys/network',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'monad-service-')),journals=join(dir,'journals');
  try{
    await assert.rejects(runMonadTestnetService({config,rules:reviewed,abi:[],rpcUrl:'https://secret.invalid/token',
      keysDirectory:dir,journalDirectory:journals,policy:parseTestnetRunPolicy(raw),durationSeconds:60,
      stopAfterFinalized:2,initialize:true},new AbortController().signal,()=>{}),/MONAD_DISABLED_TESTNET_CONFIG_REQUIRED/);
    assert.equal(existsSync(journals),false);
  }finally{rmSync(dir,{recursive:true,force:true});}
});
