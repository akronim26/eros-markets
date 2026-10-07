import assert from 'node:assert/strict';
import { test } from 'node:test';
import { keccak256 } from 'viem';
import { publicManifest as manifest, deploymentManifests } from '../../src/config/deployment';
import { client } from '../../src/lib/public-client';
import { ensureDeployment, canonicalRead } from '../../src/lib/deployment-check';

test('deployment reads reject wrong networks, changed code, bindings and canonical anchors', async (t) => {
 const c=manifest.contracts;
 const hashes=deploymentManifests.flatMap(m=>[...Object.values(m.contracts),...m.markets]);
 // Give the in-memory test manifest deterministic bytecode pins; production pins are untouched on disk.
 const original=hashes.map(v=>v.codehash);
 hashes.forEach(v=>{v.codehash=keccak256('0x1234')});
 let chain=1,code='0x1234',badBinding=false,badAnchor=false,clock=1_000_000;
 t.mock.method(Date,'now',()=>clock);
 t.mock.method(client,'getChainId',async()=>chain);
 t.mock.method(client,'call',async({data,blockNumber}:any)=>{
  assert.match(data,/^0x73[\da-fA-F]{40}3f60005260206000f3$/);
  assert.equal(blockNumber,BigInt(manifest.verifiedAt.blockNumber));
  return {data:keccak256(code as `0x${string}`)};
 });
 t.mock.method(client,'getBlock',async(args:any)=>({number:BigInt(manifest.verifiedAt.blockNumber),hash:badAnchor?keccak256('0xab'):(deploymentManifests.find(m=>BigInt(m.verifiedAt.blockNumber)===args?.blockNumber)??manifest).verifiedAt.blockHash}));
 t.mock.method(client,'readContract',async({address,functionName,args}:any)=>{
  const selected=deploymentManifests.find(d=>d.markets.some(m=>m.engine.toLowerCase()===address.toLowerCase()||m.marketId===args?.[0]))??deploymentManifests.find(d=>Object.values(d.contracts).some(c=>c.address.toLowerCase()===address.toLowerCase()))??manifest;
  const c=selected.contracts;
  const m=selected.markets.find(m=>m.engine.toLowerCase()===address.toLowerCase()||m.marketId===args?.[0]);
  if(functionName==='engineOf')return badBinding?'0x0000000000000000000000000000000000000000':m!.engine;
  if(functionName==='listing')return {marketId:m!.marketId,indexSourceId:m!.sourceId,token:c.CollateralToken.address,registry:c.MarketRegistry.address,resolutionAuthority:c.ResolutionOracle.address};
  if(functionName==='listingHash')return m!.listingHash;
  return badBinding?'0x0000000000000000000000000000000000000000':({factory:c.MarketFactory.address,oracle:c.ResolutionOracle.address,registry:c.MarketRegistry.address,collateralVault:c.CollateralVault.address,token:c.CollateralToken.address} as any)[functionName];
 });
 try {
  await assert.rejects(ensureDeployment(),/network/);
  chain=10143;code='0xab';await assert.rejects(ensureDeployment(),/code/);
  code='0x1234';badBinding=true;await assert.rejects(ensureDeployment(),/bindings/);
  badBinding=false;badAnchor=true;await assert.rejects(ensureDeployment(),/canonical/);
  badAnchor=false;await ensureDeployment();
  clock+=300001;code='0xab';await assert.rejects(ensureDeployment(),/code/);
 } finally { hashes.forEach((v,i)=>{v.codehash=original[i]}); }
});
test('a reorg during a pinned read cannot return a mixed snapshot',async(t)=>{
 let call=0;t.mock.method(client,'getBlock',async()=>({hash:++call===1?'0x12':'0x34'}));
 await assert.rejects(canonicalRead(100n,async()=>({balance:1n})),/Read block changed/);
});
