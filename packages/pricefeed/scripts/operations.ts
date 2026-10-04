import { readFileSync } from 'node:fs';
import { operationsHealth, operationsLog, parseOperationsSettings, watchOperations } from '../src/operations.js';

async function main(){
  const [command,profile,settingsFile,...extra]=process.argv.slice(2);
  if(!profile||!settingsFile||extra.length||!['health','watch'].includes(command??''))throw new Error('OPS_BAD_ARGUMENTS');
  const settings=parseOperationsSettings(JSON.parse(readFileSync(settingsFile,'utf8'))),emit=(event:unknown)=>console.log(operationsLog(event));
  if(command==='health'){const health=operationsHealth(profile,settings);emit(health);process.exitCode=health.healthy?0:1;return;}
  const stop=new AbortController(),halt=()=>stop.abort();process.on('SIGTERM',halt);process.on('SIGINT',halt);
  try{await watchOperations(profile,settings,stop.signal,emit);}
  finally{process.removeListener('SIGTERM',halt);process.removeListener('SIGINT',halt);}
}
main().catch(error=>{console.error(error instanceof Error&&/^[A-Z][A-Z0-9_]+$/.test(error.message)?error.message:'OPS_READ_FAILED');process.exitCode=1;});
