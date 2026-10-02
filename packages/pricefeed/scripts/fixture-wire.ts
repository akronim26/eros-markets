import { mkdirSync, writeFileSync } from 'node:fs';
import { privateKeyToAccount } from 'viem/accounts';
import { type Hex } from 'viem';
import { json } from '../src/math.js';
import { observationDigest, type Observation } from '../src/wire.js';

// Deterministic public test key only. It never enters the CLI or live config.
const account=privateKeyToAccount(('0x'+'11'.repeat(32)) as Hex);
const engineAddress='0x1111111111111111111111111111111111111111',chainId=31337n;
const make=(sequence:bigint,t:bigint):Observation=>({marketId:'0x'+'01'.repeat(32),sourceId:'0x'+'02'.repeat(32),sequence,observedAt:t,publishedAt:10000n,priceWad:600000000000000000n,impactBidWad:590000000000000000n,impactAskWad:610000000000000000n,bidDepthLots:5000n,askDepthLots:5000n,sourceRulesHash:'0x'+'03'.repeat(32)});
const packet=async(obs:Observation)=>{const digest=observationDigest(obs,chainId,engineAddress);return {obs,digest,signature:await account.sign({hash:digest})};};
const observation=await packet(make(1n,9990n));
const series=[];
for(let i=0;i<=10;i++)series.push(await packet(make(BigInt(i+1),9700n+BigInt(i)*30n)));
const invalid=await packet({...make(12n,10000n),priceWad:0n,bidDepthLots:499n});
const directory=new URL('../../fixtures/',import.meta.url);mkdirSync(directory,{recursive:true});
writeFileSync(new URL('wire.json',directory),json({testOnly:true,chainId,engineAddress,signerAddress:account.address,observation,series,invalid})+'\n');
console.log('Generated 13 explicitly test-only raw-signed packets for local real-ingress comparison');
