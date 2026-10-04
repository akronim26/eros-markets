import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseDeploymentProfile, prepareDeployment } from '../src/deployment.js';
import { json } from '../src/math.js';

// Explicit one-time shell action. Runtime start never calls this bootstrap.
try{
  const [command,stateArg,configArg,...extra]=process.argv.slice(2);
  if(command!=='prepare-readonly'||!stateArg||!configArg||extra.length)throw new Error('SERVICE_BAD_ARGUMENTS');
  const root=resolve(stateArg),configs=resolve(configArg),profileFile=join(root,'profile.json');
  if(existsSync(profileFile))throw new Error('SERVICE_ALREADY_PREPARED');
  const profile=parseDeploymentProfile({schemaVersion:'1',mode:'READ_ONLY_COLLECTION',stateDirectory:root,
    inputs:{configs:{path:configs,sha256:createHash('sha256').update(readFileSync(configs)).digest('hex')}},
    restart:{delayMs:60000,maxRestarts:3,stopTimeoutMs:90000},streamHints:false,testnet:null});
  prepareDeployment(profile);writeFileSync(profileFile,json(profile)+'\n',{flag:'wx',mode:0o600});
  console.log(JSON.stringify({event:'RENDER_READ_ONLY_PREPARED',transactionsSent:0,signaturesProduced:0}));
}catch(error){console.error(error instanceof Error&&/^[A-Z][A-Z0-9_]+$/.test(error.message)?error.message:'SERVICE_PREPARATION_FAILED');process.exitCode=78;}
