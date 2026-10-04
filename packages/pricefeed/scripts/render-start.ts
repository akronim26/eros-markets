import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { operationsLog, parseOperationsSettings, watchOperations } from '../src/operations.js';

/** Render restarts exited workers independently. Keep operator stops/completed
 * finite campaigns parked with no collector or signer instead of a restart storm.
 */
async function main(){
  const profile=process.env.PRICEFEED_SERVICE_PROFILE;
  const stop=new AbortController();let child:ReturnType<typeof spawn>|undefined;
  const halt=()=>{stop.abort();child?.kill('SIGTERM');};process.on('SIGINT',halt);process.on('SIGTERM',halt);
  let monitoring:Promise<void>=Promise.resolve();
  try{
    const settingsFile=process.env.PRICEFEED_OPERATIONS_CONFIG;
    if(profile&&settingsFile){
      try{const settings=parseOperationsSettings(JSON.parse(readFileSync(settingsFile,'utf8')));
        monitoring=watchOperations(profile,settings,stop.signal,event=>console.log(operationsLog(event)));}
      catch{console.log(JSON.stringify({event:'ALERT_OPEN',code:'OPS_SETTINGS_UNAVAILABLE',healthy:false,operationalOutput:false}));}
    }
    let code=78;
    if(profile){
      child=spawn(process.execPath,['--disable-warning=ExperimentalWarning',fileURLToPath(new URL('./supervise.js',import.meta.url)),'run',profile],{stdio:'inherit'});
      code=await new Promise<number>(resolve=>{child!.once('error',()=>resolve(78));child!.once('close',c=>resolve(c??78));});
    }
    if(stop.signal.aborted)return;
    console.log(JSON.stringify({event:'SERVICE_PARKED',reason:code===0?'SERVICE_FINITE_RUN_COMPLETED':'SERVICE_OPERATOR_REVIEW_REQUIRED',
      healthy:false,operationalOutput:false,signaturesProduced:0,transactionsSent:0}));
    await new Promise<void>(resolve=>{
      const timer=setInterval(()=>console.log(JSON.stringify({event:'SERVICE_PARKED',healthy:false,operationalOutput:false})),60000);
      const done=()=>{clearInterval(timer);resolve();};stop.signal.addEventListener('abort',done,{once:true});if(stop.signal.aborted)done();
    });
  }finally{stop.abort();await monitoring;process.removeListener('SIGINT',halt);process.removeListener('SIGTERM',halt);}
}
main().catch(()=>{console.error('SERVICE_RENDER_START_FAILED');process.exitCode=78;});
