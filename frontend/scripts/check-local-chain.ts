import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {createPublicClient,http,parseAbi,type Address} from 'viem';
import {engineAbi} from '../src/abi/engine';
import {marginLensAbi,marginLensCode} from '../src/abi/marginLens';
async function main(){
 const c=createPublicClient({transport:http('http://127.0.0.1:8547')});
 assert.equal(await c.getChainId(),31337);
 const log=JSON.parse(readFileSync('../contracts/broadcast/LocalBookRiskSmoke.s.sol/31337/run-latest.json','utf8'));
 const deployed=(name:string)=>log.transactions.filter((t:any)=>t.contractName===name&&t.transactionType==='CREATE').map((t:any)=>t.contractAddress as Address);
 const engine=deployed('BookRiskEngine')[0],buyer=deployed('LocalSmokeTrader')[0],token=deployed('MockUSDC')[0];
 const fills=await c.getContractEvents({address:engine,abi:engineAbi,eventName:'Fill',fromBlock:0n});
 assert.equal(fills.reduce((sum,e)=>sum+e.args.size!,0n),100000n);
 const r=await c.readContract({address:engine,abi:engineAbi,functionName:'getSettlementStatus'});
 assert.equal(r.claimsEnabled,true);assert.equal(r.halted,true);
 assert.equal(await c.readContract({address:engine,abi:engineAbi,functionName:'claimableAtoms',args:[buyer]}),0n);
 assert.equal(await c.readContract({address:engine,abi:engineAbi,functionName:'traderClaimed',args:[buyer]}),true);
 const erc20=parseAbi(['function balanceOf(address) view returns (uint256)']);
 assert.equal(await c.readContract({address:token,abi:erc20,functionName:'balanceOf',args:[buyer]}),150000000n);
 const envelope={hSecs:[300n],sigmaWad:[0n],validFrom:0n,validUntil:1000n};
 const profile={h0Secs:300n,absorptionClaimsPerMin:1000n,queueSecs:0n,hazard0WadPerDay:1n,hazard1WadPerDay:1n,epsilonWad:10n**16n,gammaWad:15n*10n**17n,sWad:5n*10n**15n,lambdaWadPerClaim:10n**12n,template:2,calibrated:true,deploymentCapX:5n,realized:envelope,templateEnv:envelope};
 const args=[0n,1000n,500000000000000000n,86400n,1000n,profile] as const;
 const h=await c.readContract({code:marginLensCode,abi:marginLensAbi,functionName:'health',args});
 const rows=await c.readContract({code:marginLensCode,abi:marginLensAbi,functionName:'healthRange',args:[0n,1000n,500,500,86400n,1000n,profile]});
 assert.deepEqual(h,rows[0]);
 console.log('Frontend ABI reads, final claims, buyer payout and deployless MarginLens passed on local chain 31337.');
}
main().catch(e=>{console.error(e);process.exitCode=1;});
