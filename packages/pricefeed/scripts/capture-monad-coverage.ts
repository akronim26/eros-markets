/** Capture a named canonical finalized-block view; no wallet/journal access. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createPublicClient, http, type Hex } from 'viem';
import { monadTestnet } from 'viem/chains';
import { parseConfig } from '../src/config.js';
import { json } from '../src/math.js';
import { monadTestnetReadRpc, parseEngineReadAbi, preflightMonadTestnet } from '../src/monad-preflight.js';

const [phase,number]=process.argv.slice(2);
assert.ok(['initial','gap','recovered'].includes(phase??''),'phase required');
assert.ok(number===undefined||/^(0|[1-9]\d*)$/.test(number),'invalid block number');
const root='artifacts/monad-testnet/',read=(name:string)=>JSON.parse(readFileSync(root+name,'utf8'));
const cfg=parseConfig(read('market-config.json')),abi=parseEngineReadAbi(read('receiver-abi.json')).abi,d=cfg.destination!;
const url=process.env.PRICEFEED_MONAD_RPC_URL;assert.ok(url,'RPC environment required');
const rpc=monadTestnetReadRpc(url),checkpoint=await preflightMonadTestnet(rpc,{config:cfg,abi});
const block=number===undefined?checkpoint.block:await rpc.block({blockNumber:BigInt(number)});
assert.ok(block.number<=checkpoint.block.number,'block is not finalized');
// Validate pins at the named block as well as at the current finalized head.
const namedRpc={...rpc,block:async(selector:Parameters<typeof rpc.block>[0])=>
  'blockTag' in selector?block:rpc.block(selector)};
const named=await preflightMonadTestnet(namedRpc,{config:cfg,abi},()=>block.timestamp*1000n);
const client=createPublicClient({chain:monadTestnet,transport:http(url,{timeout:5000,retryCount:0,fetchOptions:{redirect:'error'}})});
const actual=await client.readContract({address:d.engineAddress as Hex,abi,functionName:'indexTwap300',
  args:[block.timestamp],blockNumber:block.number});
assert.deepEqual(await rpc.block({blockNumber:block.number}),block,'canonical block changed');
console.log(json({mode:'MONAD_TESTNET_COVERAGE_CHECKPOINT',phase,chainId:10143,block,actual,
  sourceState:named.engine!.sourceState,finalizedHead:checkpoint.block,engine:d.engineAddress,
  transactionsSent:0,signaturesProduced:0,productionApproved:false}));
