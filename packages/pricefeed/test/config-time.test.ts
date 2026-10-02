import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { parseConfig, validateOperationalAdmission, verifyListing } from '../src/config.js';
import { sourceTime } from '../src/time.js';

const example = JSON.parse(readFileSync(new URL('../../config/crypto.example.json', import.meta.url), 'utf8'));
test('categories share a schema; disabled diagnostic examples cannot sign', () => {
  for (const category of ['crypto','sports','politics']) {
    const c = parseConfig({...example,category});
    assert.equal(c.category,category);
    assert.equal(c.enabled,false);
    assert.throws(() => validateOperationalAdmission(c, 0n), /DISABLED/);
  }
  assert.throws(() => parseConfig({...example,category:'forex'}));
  assert.throws(() => parseConfig({...example,enabled:true}));
});
test('missing policies, unsafe integers and token/domain placeholders are rejected', () => {
  for (const field of ['mapping','pricing','poll','policies']) {
    const copy = {...example}; delete copy[field];
    assert.throws(() => parseConfig(copy));
  }
  assert.throws(() => parseConfig({...example,mapping:{...example.mapping,outcomeTokenId:123}}));
  assert.throws(() => parseConfig({...example,pricing:{...example.pricing,depthNLots:'0'}}));
  assert.throws(() => parseConfig({...example,poll:{...example.poll,intervalMs:10.5}}));
  assert.throws(() => parseConfig({...example,destination:{chainId:'1',engineAddress:'TODO'}}));
});
test('listing verification fails closed on any pinned field mismatch', () => {
  const cfg = parseConfig({...example,destination:{chainId:'31337',engineAddress:'0x1111111111111111111111111111111111111111',engineCodeHash:'0x'+'aa'.repeat(32),abiHash:'0x'+'bb'.repeat(32),marketId:'0x'+'01'.repeat(32),sourceId:'0x'+'02'.repeat(32),sourceRulesHash:'0x'+'03'.repeat(32),signerAddress:'0x2222222222222222222222222222222222222222',scheduledT:'90000',listedAt:'0',invalidRule:{captureGraceSecs:'3600',voidSecs:'2592000',fallbackListed:true,fallbackPriceWad:'500000000000000000'}}});
  const listing = { ...cfg.destination!, indexSourceId:cfg.destination!.sourceId,indexSigner:cfg.destination!.signerAddress,indexRulesHash:cfg.destination!.sourceRulesHash, depthNLots:cfg.pricing.depthNLots,maxSpreadWad:cfg.pricing.maxSpreadWad };
  verifyListing(cfg,listing);
  assert.throws(() => verifyListing(cfg,{...listing,depthNLots:'500'}));
  assert.throws(() => verifyListing(cfg,{...listing,indexRulesHash:'0x'+'04'.repeat(32)}));
});
test('source time preserves milliseconds, floors seconds and never refreshes an old snapshot', () => {
  assert.equal(sourceTime('1000999',1029000n,null,0n).observedAt,1000n);
  assert.equal(sourceTime('1000000',1030000n,null,0n).fresh,true);
  assert.equal(sourceTime('1000000',1031000n,null,0n).fresh,false);
  assert.equal(sourceTime('1000001',1000000n,null,0n).fresh,false);
  assert.equal(sourceTime('1000000',1000001n,1001000n,0n).monotone,false);
  assert.equal(sourceTime('1000000',1000001n,1000000n,0n).advanced,false);
  assert.equal(sourceTime('1000000',1029000n,null,2000n).hasHeadroom,false);
  for (const value of [undefined,1000,'-1','1e3','']) assert.throws(() => sourceTime(value,1000000n,null,0n));
});
