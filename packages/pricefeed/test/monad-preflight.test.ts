import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { decodeFunctionData, encodeFunctionResult, keccak256, type Hex } from 'viem';
import { monadTestnetReadRpc, parseEngineReadAbi, preflightMonadTestnet, type MonadReadRpc } from '../src/monad-preflight.js';
import { config, h } from './publication-fixture.js';

// The exported abstract engine ABI is the real read interface, not the local demo tuple.
const artifact:unknown=JSON.parse(readFileSync(new URL('../../../../artifacts/risk/engine-abi.json',import.meta.url),'utf8'));
const parsed=parseEngineReadAbi(artifact),code='0x60006000' as Hex;
function setup(){
  let now=1000100n,chain=10143,changed=false,halted:unknown=false;
  const calls:{name:string;block?:bigint}[]=[],cfg=structuredClone(config);
  cfg.destination={...cfg.destination!,chainId:'10143',engineCodeHash:keccak256(code),abiHash:parsed.abiHash};
  const d=cfg.destination;
  const listing:Record<string,unknown>={...d,indexSourceId:d.sourceId,indexSigner:d.signerAddress,indexRulesHash:d.sourceRulesHash,
    depthNLots:BigInt(cfg.pricing.depthNLots),maxSpreadWad:BigInt(cfg.pricing.maxSpreadWad),scheduledT:BigInt(d.scheduledT),listedAt:0n};
  const state:Record<string,unknown>={signer:d.signerAddress,rulesHash:d.sourceRulesHash,lastSequence:7n,lastObservedAt:999n,configured:true};
  const rpc:MonadReadRpc={
    chainId:async()=>{calls.push({name:'chain'});return chain;},
    block:async(selector)=>{calls.push({name:'blockTag' in selector?selector.blockTag:'canonical'});
      return {number:'blockNumber' in selector?selector.blockNumber:10n,
        hash:h(changed&&'blockNumber' in selector?'bb':'aa') as Hex,timestamp:1000n};},
    code:async(_address,block)=>{calls.push({name:'code',block});return code;},
    read:async(engine,abi,name,sourceId,block)=>{calls.push({name,block});assert.equal(engine,d.engineAddress);
      assert.equal(sourceId,d.sourceId);assert.deepEqual(abi,parsed.abi);
      return name==='listing'?listing:name==='sourceState'?state:halted;},
  };
  return {rpc,cfg,listing,state,calls,clock:()=>now,setNow:(value:bigint)=>{now=value;},
    setChain:(value:number)=>{chain=value;},changeBlock:()=>{changed=true;},setHalted:(value:unknown)=>{halted=value;},
    run:()=>preflightMonadTestnet(rpc,{config:cfg,abi:artifact},()=>now)};
}

test('Monad preflight verifies network alone without requiring an engine or touching contract state',async()=>{
  const f=setup(),r=await preflightMonadTestnet(f.rpc,undefined,f.clock);
  assert.equal(r.status,'NETWORK_VERIFIED_ENGINE_NOT_CONFIGURED');assert.equal(r.engine,null);
  assert.equal(r.operationalOutput,false);assert.equal(r.transactionsSent,0);assert.equal(r.signaturesProduced,0);
  assert.deepEqual(f.calls.map(c=>c.name),['chain','finalized','canonical','chain']);
});

test('Monad engine reads use one named finalized block and real ABI pins, including authoritative halt',async()=>{
  const f=setup();f.setHalted(true);const r=await f.run();
  assert.equal(r.status,'ENGINE_PINS_VERIFIED');assert.equal(r.chainId,10143n);
  assert.equal(r.engine!.sourceState.lastSequence,7n);assert.equal(r.engine!.lifecycle.halted,true);
  assert.equal(r.engine!.lifecycle.canonical,true);assert.equal(r.engine!.lifecycle.blockHash,r.block.hash);
  assert.equal(r.engine!.lifecycle.scheduledT,100000n);
  assert.deepEqual(f.calls.filter(c=>c.block!==undefined).map(c=>[c.name,c.block]),
    [['code',10n],['listing',10n],['sourceState',10n],['halted',10n]]);
  assert.equal(r.operationalOutput,false);
});

test('Monad rejects wrong network initially and after a provider changes network',async()=>{
  const f=setup();f.setChain(143);await assert.rejects(f.run(),/MONAD_WRONG_CHAIN/);
  assert.deepEqual(f.calls.map(c=>c.name),['chain']);
  const g=setup();let calls=0;g.rpc.chainId=async()=>++calls===1?10143:31337;
  await assert.rejects(g.run(),/MONAD_WRONG_CHAIN/);
});

test('Monad finalized and canonical reads fail closed without latest fallback',async()=>{
  const f=setup();f.changeBlock();await assert.rejects(f.run(),/MONAD_BLOCK_CHANGED/);
  const g=setup();g.rpc.block=async()=>{throw new Error('secret-provider-url');};
  await assert.rejects(g.run(),/^Error: MONAD_FINALIZED_BLOCK_FAILED$/);
  assert.deepEqual(g.calls.map(c=>c.name),['chain']);
  const k=setup(),block=k.rpc.block;k.rpc.block=async(s)=>{
    const b=await block(s);return {...b,...('blockNumber' in s?{timestamp:999n}:{})};};
  await assert.rejects(k.run(),/MONAD_BLOCK_CHANGED/);
});

test('final canonical and chain checks run concurrently and both complete before accepting a checkpoint',async()=>{
  const f=setup(),block=f.rpc.block,chain=f.rpc.chainId;
  let release:()=>void=()=>{},chainCalls=0,canonicalDone=false;
  const barrier=new Promise<void>(resolve=>{release=resolve;});
  const timeout=setTimeout(()=>release(),1000);
  f.rpc.block=async selector=>{
    if('blockNumber' in selector){await barrier;assert.equal(chainCalls,2,'extra serial chain round trip');canonicalDone=true;}
    return block(selector);
  };
  f.rpc.chainId=async()=>{chainCalls++;if(chainCalls===2)release();return chain();};
  try{await f.run();assert.equal(canonicalDone,true);assert.equal(chainCalls,2);}
  finally{clearTimeout(timeout);}
  const g=setup();let calls=0;
  g.rpc.chainId=async()=>++calls===1?10143:143;
  const originalBlock=g.rpc.block;
  g.rpc.block=async selector=>{if('blockNumber' in selector)throw new Error('private endpoint');return originalBlock(selector);};
  await assert.rejects(g.run(),/^Error: MONAD_CANONICAL_BLOCK_FAILED$/);
  assert.equal(calls,2);
});

test('Monad rejects stale, future, malformed and slow-to-complete block checkpoints',async()=>{
  for(const time of [1030001n,999999n]){const f=setup();f.setNow(time);await assert.rejects(f.run(),/MONAD_STALE_OR_FUTURE_BLOCK/);}
  const f=setup(),read=f.rpc.read;f.rpc.read=async(...args)=>{f.setNow(1030001n);return read(...args);};
  await assert.rejects(f.run(),/MONAD_STALE_OR_FUTURE_BLOCK/);
  const g=setup();g.rpc.block=async()=>({number:10n,hash:'0x' as Hex,timestamp:1000n});
  await assert.rejects(g.run(),/MONAD_BAD_BLOCK/);
});

test('Monad requires matching runtime code and ABI before accepting listing reads',async()=>{
  for(const value of [undefined,'0x' as Hex,'0x1' as Hex]){const f=setup();f.rpc.code=async()=>value;await assert.rejects(f.run(),/MONAD_ENGINE_CODE_MISSING/);}
  const f=setup();f.cfg.destination!.engineCodeHash=h('ee');await assert.rejects(f.run(),/MONAD_CODE_PIN_MISMATCH/);
  assert.equal(f.calls.some(c=>c.name==='listing'),false);
  const g=setup();g.cfg.destination!.abiHash=h('ee');await assert.rejects(g.run(),/MONAD_ABI_PIN_MISMATCH/);
  assert.equal(g.calls.length,0);
  for(const chain of ['31337','143']){const k=setup();k.cfg.destination!.chainId=chain;await assert.rejects(k.run(),/MONAD_DISABLED_TESTNET_CONFIG_REQUIRED/);}
});

test('Monad listing mismatch blocks every market, signer, rules, depth, time and invalid-rule pin',async()=>{
  for(const field of ['marketId','indexSourceId','indexSigner','indexRulesHash','depthNLots','maxSpreadWad','scheduledT','listedAt']){
    const f=setup();f.listing[field]='mismatch';await assert.rejects(f.run(),/MONAD_LISTING_PIN_MISMATCH/);
  }
  for(const field of ['fallbackListed','captureGraceSecs','fallbackPriceWad','voidSecs']){
    const f=setup();f.listing.invalidRule={...f.cfg.destination!.invalidRule,[field]:'mismatch'};
    await assert.rejects(f.run(),/MONAD_LISTING_PIN_MISMATCH/);
  }
});

test('Monad source reads reject missing setup, changed signer/rules and contradictory or malformed state',async()=>{
  for(const field of ['signer','rulesHash']){const f=setup();f.state[field]=field==='signer'?'0x'+'33'.repeat(20):h('cc');await assert.rejects(f.run(),/MONAD_SOURCE_PIN_MISMATCH/);}
  const f=setup();f.state.configured=false;await assert.rejects(f.run(),/MONAD_SOURCE_NOT_CONFIGURED/);
  for(const state of [{lastSequence:-1n},{lastObservedAt:'999'},{configured:'true'},{lastSequence:1n<<64n}]){
    const g=setup();Object.assign(g.state,state);await assert.rejects(g.run(),/MONAD_BAD_SOURCE_STATE/);
  }
  for(const state of [{lastObservedAt:1001n},{lastSequence:0n,lastObservedAt:999n}]){
    const g=setup();Object.assign(g.state,state);await assert.rejects(g.run(),/MONAD_SOURCE_STATE_CONTRADICTION/);
  }
  const g=setup();g.setHalted('false');await assert.rejects(g.run(),/MONAD_BAD_HALT_STATE/);
});

test('Monad RPC errors are fixed codes and never contain endpoint credentials or provider messages',async()=>{
  for(const name of ['listing','sourceState','halted'] as const){
    const f=setup(),read=f.rpc.read;f.rpc.read=async(...args)=>{if(args[2]===name)throw new Error('https://provider.invalid/private-api-key');return read(...args);};
    await assert.rejects(f.run(),error=>error instanceof Error&&/^MONAD_(LISTING|SOURCE|HALT)_READ_FAILED$/.test(error.message));
  }
});

test('Monad read ABI matches the production tuple and rejects shortened, reordered, writable and duplicate functions',()=>{
  assert.deepEqual(parseEngineReadAbi(parsed.abi),parsed);
  for(const change of ['short','reorder','write','duplicate']){
    const abi=structuredClone(parsed.abi) as unknown as Record<string,any>[];
    const listing=abi.find(i=>i.name==='listing')!;
    if(change==='short')listing.outputs[0].components.pop();
    if(change==='reorder')listing.outputs[0].components.reverse();
    if(change==='write')listing.stateMutability='nonpayable';
    if(change==='duplicate')abi.push(structuredClone(listing));
    assert.throws(()=>parseEngineReadAbi(abi),/MONAD_ENGINE_READ_ABI_MISMATCH/);
  }
});

test('Monad read adapter requires HTTPS, hides URL parse errors and exposes no wallet or send methods',()=>{
  for(const url of ['https://u:secret@rpc.invalid','http://localhost:8545','https://rpc.invalid/#secret'])
    assert.throws(()=>monadTestnetReadRpc(url),/MONAD_HTTPS_RPC_REQUIRED/);
  assert.throws(()=>monadTestnetReadRpc('secret bad url'),/^Error: MONAD_BAD_RPC_URL$/);
  assert.deepEqual(Object.keys(monadTestnetReadRpc('https://rpc.invalid/private-api-key')).sort(),['block','chainId','code','read']);
});

test('Concrete Monad HTTP adapter encodes and decodes the real listing/source/halt ABI at the pinned block',async()=>{
  const f=setup(),oldFetch=globalThis.fetch,requests:{method:string;params:unknown[]}[]=[];
  const listing={...f.listing,token:'0x'+'44'.repeat(20),registry:'0x'+'44'.repeat(20),
    resolutionAuthority:'0x'+'44'.repeat(20),monitor:'0x'+'44'.repeat(20),governance:'0x'+'44'.repeat(20),
    sourceHash:h('01'),rulesHash:h('03'),template:0,deploymentCapX:0n,maxTraders:0,bootstrapBandWad:0n,
    minOrderLots:1n,maxOrderLots:10n,maxLiqLotsPerBlock:100n,fundingEnabled:false};
  globalThis.fetch=async(_input,init)=>{
    const req=JSON.parse(String(init!.body));requests.push(req);let result:unknown;
    if(req.method==='eth_chainId')result='0x279f';
    else if(req.method==='eth_getBlockByNumber')result={number:'0xa',hash:h('aa'),timestamp:'0x3e8',transactions:[]};
    else if(req.method==='eth_getCode'){assert.equal(req.params[1],'0xa');result=code;}
    else if(req.method==='eth_call'){
      assert.equal(req.params[1],'0xa');assert.equal(req.params[0].to.toLowerCase(),f.cfg.destination!.engineAddress.toLowerCase());
      const fn=decodeFunctionData({abi:parsed.abi,data:req.params[0].data});
      if(fn.functionName==='sourceState')assert.deepEqual(fn.args,[f.cfg.destination!.sourceId]);
      result=encodeFunctionResult({abi:parsed.abi,functionName:fn.functionName,
        result:fn.functionName==='listing'?listing:fn.functionName==='sourceState'?f.state:true});
    }else assert.fail(`Unexpected method ${req.method}`);
    return new Response(JSON.stringify({jsonrpc:'2.0',id:req.id,result}),{headers:{'Content-Type':'application/json'}});
  };
  try{
    const r=await preflightMonadTestnet(monadTestnetReadRpc('https://rpc.invalid/private-api-key'),{config:f.cfg,abi:artifact},f.clock);
    assert.equal(r.status,'ENGINE_PINS_VERIFIED');assert.equal(r.engine!.lifecycle.halted,true);
    assert.equal(r.engine!.sourceState.lastSequence,7n);
    assert.deepEqual(requests.filter(q=>q.method==='eth_getBlockByNumber').map(q=>q.params[0]),['finalized','0xa']);
    assert.equal(requests.filter(q=>q.method==='eth_call').length,3);
    assert.equal(requests.some(q=>q.method.startsWith('eth_send')),false);
  }finally{globalThis.fetch=oldFetch;}
});
