import { closeSync, fstatSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { checkDeployment, loadDeploymentProfile, openDeploymentLock, prepareDeployment, SERVICE_OPERATOR_STOP,
  SERVICE_RUNTIME } from '../src/deployment.js';
import { supervise } from '../src/supervisor.js';

const emit=(value:unknown)=>console.log(JSON.stringify(value));
async function main(){
  const [command,file,...extra]=process.argv.slice(2);
  if(!file||extra.length||!['prepare','check','run','locked'].includes(command??''))throw new Error('SERVICE_BAD_ARGUMENTS');
  if(process.platform!=='linux'||process.version!==SERVICE_RUNTIME)throw new Error('SERVICE_PINNED_LINUX_RUNTIME_REQUIRED');
  const profile=loadDeploymentProfile(file);
  if(command==='prepare'){prepareDeployment(profile);emit({event:'SERVICE_PREPARED',mode:profile.mode,transactionsSent:0});return;}
  checkDeployment(profile);
  if(command==='check'){emit({event:'SERVICE_CHECKED',mode:profile.mode,transactionsSent:0});return;}
  if(command==='locked'){
    // Inherited OFD lock descriptor, retained in every worker to outlive a crashed supervisor.
    const fd=fstatSync(3);if(!fd.isFile()||fd.uid!==process.getuid?.())throw new Error('SERVICE_LOCK_DESCRIPTOR_REQUIRED');
    const stop=new AbortController(),halt=()=>stop.abort();process.on('SIGINT',halt);process.on('SIGTERM',halt);
    try{emit({event:'SUPERVISOR_READY',pid:process.pid});process.exitCode=await supervise(file,stop.signal,emit);}
    finally{process.removeListener('SIGINT',halt);process.removeListener('SIGTERM',halt);}return;
  }
  const fd=openDeploymentLock(profile);
  try{
    const child=spawn('/bin/sh',['-c','/usr/bin/flock --nonblock --conflict-exit-code 78 3 || exit 78; exec "$@"','pricefeed-service',process.execPath,
      fileURLToPath(import.meta.url),'locked',file],{detached:true,stdio:['ignore','inherit','inherit',fd]});
    emit({event:'LOCK_HOLDER_STARTED',pid:child.pid});let killTimer:ReturnType<typeof setTimeout>|undefined;
    const halt=()=>{try{process.kill(-child.pid!,'SIGTERM');}catch{/* Child may already have drained. */}
      killTimer??=setTimeout(()=>{try{process.kill(-child.pid!,'SIGKILL');}catch{/* Already stopped. */}},profile.restart.stopTimeoutMs);};
    process.on('SIGINT',halt);process.on('SIGTERM',halt);
    try{
      process.exitCode=await new Promise<number>((resolve,reject)=>{
        child.once('error',()=>reject(new Error('SERVICE_FLOCK_UNAVAILABLE')));
        child.once('close',(code,signal)=>{if(code===78)emit({event:'OPERATOR_STOP',reason:'SERVICE_LOCKED_OR_WORKER_STOPPED'});
          resolve(code??(signal==='SIGTERM'?0:SERVICE_OPERATOR_STOP));});
      });
    }finally{if(killTimer)clearTimeout(killTimer);process.removeListener('SIGINT',halt);process.removeListener('SIGTERM',halt);}
  }finally{closeSync(fd);}
}
main().catch(error=>{console.error(error instanceof Error&&/^[A-Z][A-Z0-9_]+$/.test(error.message)?error.message:'SERVICE_PREFLIGHT_FAILED');
  process.exitCode=SERVICE_OPERATOR_STOP;});
