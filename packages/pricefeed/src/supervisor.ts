import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { checkDeployment, loadDeploymentProfile, readSupervision, SERVICE_OPERATOR_STOP, sourceLeaseWaitMs, writeSupervision } from './deployment.js';

export type SupervisorEvent={event:string;pid?:number;attempt?:number;delayMs?:number;code?:number|null;signal?:string|null;reason?:string};
/** Only declared transient failures/crashes restart. Successful/finite/operator stops never repeat. */
export function restartable(code:number|null,signal:string|null,diagnostic:string):boolean {
  if(signal)return ['SIGKILL','SIGSEGV','SIGABRT','SIGBUS'].includes(signal);
  return code===1&&['WRITER_BUSY','PIPELINE_TIMEOUT','RELAY_TIMEOUT','MONAD_RPC_TIMEOUT','SOURCE_TIMEOUT'].includes(diagnostic);
}
function pause(ms:number,signal:AbortSignal):Promise<void>{
  if(signal.aborted)return Promise.resolve();
  return new Promise(resolve=>{const done=()=>{clearTimeout(timer);signal.removeEventListener('abort',done);resolve();};
    const timer=setTimeout(done,ms);signal.addEventListener('abort',done,{once:true});if(signal.aborted)done();});
}
export async function supervise(profilePath:string,signal:AbortSignal,emit:(event:SupervisorEvent)=>void):Promise<number>{
  const profile=loadDeploymentProfile(profilePath),saved=readSupervision(profile);
  if(saved.phase==='OPERATOR_STOP'){emit({event:'OPERATOR_STOP',reason:saved.reason??'SERVICE_OPERATOR_REVIEW_REQUIRED'});return SERVICE_OPERATOR_STOP;}
  let restarts=saved.restarts;
  if(saved.phase==='RUNNING')restarts++;
  const operatorStop=(reason:string)=>{writeSupervision(profile,{phase:'OPERATOR_STOP',restarts,reason});emit({event:'OPERATOR_STOP',reason});return SERVICE_OPERATOR_STOP;};
  if(restarts>profile.restart.maxRestarts)return operatorStop('SERVICE_RESTART_LIMIT');
  while(!signal.aborted){
    checkDeployment(profile);
    const wait=sourceLeaseWaitMs(profile);
    if(wait>3600000n)throw new Error('SERVICE_LEASE_WAIT_TOO_LONG');
    if(wait>0n){emit({event:'LEASE_WAIT',delayMs:Number(wait)});await pause(Number(wait)+1,signal);if(signal.aborted)break;checkDeployment(profile);}
    writeSupervision(profile,{phase:'RUNNING',restarts,reason:null});
    const child=spawn(process.execPath,['--disable-warning=ExperimentalWarning',fileURLToPath(new URL('../scripts/supervised-worker.js',import.meta.url)),profilePath],
      {stdio:['ignore','inherit','pipe',3]});
    let stderr='';child.stderr!.on('data',(bytes:Buffer)=>{stderr=(stderr+bytes.toString('utf8')).slice(-4096);});
    emit({event:'WORKER_STARTED',pid:child.pid!,attempt:restarts});
    const outcome=await new Promise<{code:number|null;signal:string|null}>((resolve,reject)=>{
      let killTimer:ReturnType<typeof setTimeout>|undefined;
      const stop=()=>{child.kill('SIGTERM');killTimer??=setTimeout(()=>child.kill('SIGKILL'),profile.restart.stopTimeoutMs);};
      signal.addEventListener('abort',stop,{once:true});if(signal.aborted)stop();
      const cleanup=()=>{if(killTimer)clearTimeout(killTimer);signal.removeEventListener('abort',stop);};
      child.once('error',()=>{cleanup();reject(new Error('SERVICE_WORKER_SPAWN_FAILED'));});
      child.once('close',(code,signaled)=>{cleanup();resolve({code,signal:signaled});});
    });
    const diagnostic=stderr.trim();
    const fixed=/^[A-Z][A-Z0-9_]*(?::[A-Z0-9_]+)?(?:--[a-z-]+)?$/.test(diagnostic)?diagnostic:'SERVICE_WORKER_FAILED';
    emit({event:'WORKER_EXIT',...outcome,reason:fixed});
    if(signal.aborted||outcome.code===0){writeSupervision(profile,{phase:'STOPPED',restarts,reason:null});return 0;}
    if(!restartable(outcome.code,outcome.signal,fixed)||restarts>=profile.restart.maxRestarts){
      return operatorStop(restarts>=profile.restart.maxRestarts?'SERVICE_RESTART_LIMIT':fixed.replace(/:[A-Z_]+$/,''));
    }
    restarts++;emit({event:'RESTART_WAIT',attempt:restarts,delayMs:profile.restart.delayMs});
    writeSupervision(profile,{phase:'STOPPED',restarts,reason:null});await pause(profile.restart.delayMs,signal);
  }
  writeSupervision(profile,{phase:'STOPPED',restarts,reason:null});
  return 0;
}
