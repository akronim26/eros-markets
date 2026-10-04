import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseTestnetRunPolicy, runMonadTestnetService } from '../src/monad-service.js';
import { config, reviewed } from './publication-fixture.js';

const raw={schemaVersion:'1',sender:'0x'+'12'.repeat(20),relay:{gasCap:'800000',maxFeePerGas:'150000000000',
  maxPriorityFeePerGas:'2000000000',maxCostWei:'120000000000000000',headroomMs:'5000',confirmations:'1',
  leaseMs:'120000',timeoutMs:10000,maxAttempts:3},budget:{maxTransactions:3,totalMaxCostWei:'360000000000000000'}};
test('testnet pilot policy rejects unsafe ceilings, latest-style confirmation counts and missing limits',()=>{
  const parsed=parseTestnetRunPolicy(raw);assert.equal(parsed.budget.totalMaxCostWei,360000000000000000n);
  for(const value of [{...raw,budget:{...raw.budget,maxTransactions:0}},
    {...raw,relay:{...raw.relay,confirmations:'2'}},{...raw,relay:{...raw.relay,maxFeePerGas:'0'}},
    {...raw,relay:{...raw.relay,maxPriorityFeePerGas:'150000000001'}},
    {...raw,budget:{...raw.budget,totalMaxCostWei:'1'}}])assert.throws(()=>parseTestnetRunPolicy(value));
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
