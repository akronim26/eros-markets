import assert from 'node:assert/strict';
import { test } from 'node:test';
import { keccak256 } from 'viem';
import { publicManifest as manifest } from '../../src/config/deployment';
import { client } from '../../src/lib/public-client';
import { ensureDeployment, canonicalRead } from '../../src/lib/deployment-check';

test('deployment reads reject wrong networks, changed code, bindings and canonical anchors', async (t) => {
 const c=manifest.contracts,m=manifest.markets[0];
 const hashes=[...Object.values(c),{address:m.engine,codehash:m.codehash}];
 // Give the in-memory test manifest deterministic bytecode pins; production pins are untouched on disk.
 const original=hashes.map(v=>v.codehash);
 hashes.forEach(v=>{v.codehash=keccak256('0x1234')});
 const marketHash=m.codehash;m.codehash=keccak256('0x1234');
 let chain=1,code='0x1234',badBinding=false,badAnchor=false,clock=1_000_000;
 t.mock.method(Date,'now',()=>clock);
 t.mock.method(client,'getChainId',async()=>chain);
 t.mock.method(client,'getCode',async()=>code);
 t.mock.method(client,'getBlock',async()=>({number:BigInt(manifest.verifiedAt.blockNumber),hash:badAnchor?keccak256('0xab'):manifest.verifiedAt.blockHash}));
 t.mock.method(client,'readContract',async({address,functionName}:any)=>{
  if(functionName==='listing')return {marketId:m.marketId,indexSourceId:m.sourceId,token:c.CollateralToken.address,registry:c.MarketRegistry.address,resolutionAuthority:c.ResolutionOracle.address};
  if(functionName==='listingHash')return m.listingHash;
  return badBinding?'0x0000000000000000000000000000000000000000':({factory:c.MarketFactory.address,oracle:c.ResolutionOracle.address,registry:c.MarketRegistry.address,collateralVault:c.CollateralVault.address,token:c.CollateralToken.address,engineOf:m.engine} as any)[functionName];
 });
 try {
  await assert.rejects(ensureDeployment(),/network/);
  chain=10143;code='0xab';await assert.rejects(ensureDeployment(),/code/);
  code='0x1234';badBinding=true;await assert.rejects(ensureDeployment(),/bindings/);
  badBinding=false;badAnchor=true;await assert.rejects(ensureDeployment(),/canonical/);
  badAnchor=false;await ensureDeployment();
  clock+=300001;code='0xab';await assert.rejects(ensureDeployment(),/code/);
 } finally { hashes.forEach((v,i)=>{v.codehash=original[i]});m.codehash=marketHash; }
});
test('a reorg during a pinned read cannot return a mixed snapshot',async(t)=>{
 let call=0;t.mock.method(client,'getBlock',async()=>({hash:++call===1?'0x12':'0x34'}));
 await assert.rejects(canonicalRead(100n,async()=>({balance:1n})),/Read block changed/);
});
