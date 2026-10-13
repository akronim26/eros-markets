import { randomUUID } from 'node:crypto';
import { checkDeployment, deploymentDeadline, deploymentInputs, deploymentSourcePath, loadDeploymentProfile,
  SERVICE_OPERATOR_STOP } from '../src/deployment.js';
import { Journal } from '../src/journal.js';
import { Worker } from '../src/worker.js';
import { PublicPolymarket, RequestLimiter } from '../src/polymarket.js';
import { CollectionService } from '../src/service.js';
import { MarketStreamHints } from '../src/market-stream.js';
import { parseConfig } from '../src/config.js';
import { parseRules } from '../src/rules.js';

const emit=(value:unknown)=>console.log(JSON.stringify(value));
async function main(){
  const [file,...extra]=process.argv.slice(2);if(!file||extra.length)throw new Error('SERVICE_PROFILE_REQUIRED');
  const p=loadDeploymentProfile(file),configs=checkDeployment(p),stop=new AbortController();let operatorStop=false;
  // The owned process group and supervisor may both deliver TERM. Keep the
  // handler installed through draining so a second TERM cannot bypass cleanup.
  const halt=()=>stop.abort();process.on('SIGINT',halt);process.on('SIGTERM',halt);
  try{
    emit({event:'WORKER_READY',pid:process.pid,mode:p.mode,operationalOutput:false});
    if(p.mode==='READ_ONLY_COLLECTION'){
      const journal=new Journal(deploymentSourcePath(p)),owner=randomUUID(),limiter=new RequestLimiter(100,200);
      const workers=configs.map(c=>new Worker(c,new PublicPolymarket(c.poll,limiter),journal,owner));
      try{
        const stream=p.streamHints?new MarketStreamHints(workers):null;
        const coupled=(run:Promise<void>)=>run.finally(()=>stop.abort());
        const runs=[coupled(new CollectionService(workers).run(stop.signal,result=>{
          emit({event:'SOURCE_CAPTURE',worker:result.worker,atMs:result.atMs.toString(),status:result.inspection.status,
            reason:result.inspection.reason,observedAt:result.inspection.time?.observedAt.toString()??null,operationalOutput:false});
          if(result.inspection.status==='QUARANTINED'){operatorStop=true;stop.abort();}
        }))];
        if(stream)runs.push(coupled(stream.run(stop.signal)));
        const outcomes=await Promise.allSettled(runs),failed=outcomes.find(r=>r.status==='rejected');
        if(failed?.status==='rejected')throw failed.reason;
        if(!journal.verify())throw new Error('SERVICE_ARCHIVE_INTEGRITY');
      }finally{try{workers.forEach(w=>w.releaseLease());}finally{journal.close();}}
    }else{
      const input=deploymentInputs(p),t=p.testnet!,rpcUrl=process.env[t.rpcEnv];if(!rpcUrl)throw new Error('MONAD_RPC_ENV_MISSING');
      const left=(deploymentDeadline(p)!-BigInt(Date.now()))/1000n;if(left<1n)throw new Error('SERVICE_CAMPAIGN_EXPIRED');
      const {runMonadTestnetService,parseTestnetRunPolicy}=await import('../src/monad-service.js');
      const result=await runMonadTestnetService({config:parseConfig(input.config),rules:parseRules(input.rules),abi:input.abi,rpcUrl,
        keysDirectory:t.keysDirectory,journalDirectory:t.journalDirectory,policy:parseTestnetRunPolicy(input.policy),
        durationSeconds:Math.min(t.durationSeconds,Number(left)),stopAfterFinalized:t.stopAfterFinalized,initialize:false,streamHints:p.streamHints},
      stop.signal,r=>{
        emit({event:'PUBLICATION_RESULT',worker:r.worker,state:r.state,reason:r.reason,sequence:r.sequence?.toString()??null});
        if(r.state==='QUARANTINED'||r.reason==='TESTNET_RELAY_BUDGET_EXHAUSTED'){operatorStop=true;stop.abort();}
      });
      if(!result.evidenceValid)throw new Error('SERVICE_ARCHIVE_INTEGRITY');
      // A finite campaign is never relaunched just because it did not meet its target.
      if(Number(result.finalizedPackets)<t.stopAfterFinalized&&!stop.signal.aborted)operatorStop=true;
    }
    emit({event:'WORKER_STOPPED',operatorStop});if(operatorStop)process.exitCode=SERVICE_OPERATOR_STOP;
  }finally{process.removeListener('SIGINT',halt);process.removeListener('SIGTERM',halt);}
}
main().catch(error=>{const code=error instanceof Error&&/^[A-Z][A-Z0-9_]*(?::[A-Z0-9_]+)?$/.test(error.message)?error.message:'SERVICE_WORKER_FAILED';
  console.error(code);process.exitCode=1;});
