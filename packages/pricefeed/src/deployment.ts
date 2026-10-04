import { closeSync, constants, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { record } from './book.js';
import { parseConfig, type MarketConfig } from './config.js';
import { Journal } from './journal.js';
import { json, uint } from './math.js';
import { testnetJournalPath } from './monad-keys.js';
import { ensureUniqueWorkers, workerNamespace } from './worker.js';

export const SERVICE_OPERATOR_STOP=78;
export const SERVICE_RUNTIME='v24.21.0';
export type DeploymentProfile={schemaVersion:'1';mode:'READ_ONLY_COLLECTION'|'MONAD_TESTNET';stateDirectory:string;
  inputs:Record<string,{path:string;sha256:string}>;restart:{delayMs:number;maxRestarts:number;stopTimeoutMs:number};streamHints:boolean;
  testnet:{rpcEnv:string;keysDirectory:string;journalDirectory:string;notAfterMs:string;durationSeconds:number;stopAfterFinalized:number}|null};
const sha=(data:string|Buffer)=>createHash('sha256').update(data).digest('hex');
const integer=(value:unknown,min:number,max:number)=>{
  if(typeof value!=='number'||!Number.isSafeInteger(value)||value<min||value>max)throw new Error('SERVICE_BAD_PROFILE');return value;
};
function path(value:unknown):string {
  if(typeof value!=='string'||!isAbsolute(value)||value.length>4096||value.includes('\0'))throw new Error('SERVICE_ABSOLUTE_PATH_REQUIRED');
  return resolve(value);
}
export function parseDeploymentProfile(value:unknown):DeploymentProfile {
  const p=record(value),r=record(p.restart),inputs=record(p.inputs);
  if(p.schemaVersion!=='1'||!['READ_ONLY_COLLECTION','MONAD_TESTNET'].includes(String(p.mode))||typeof p.streamHints!=='boolean')throw new Error('SERVICE_BAD_PROFILE');
  const names=p.mode==='READ_ONLY_COLLECTION'?['configs']:['config','rules','abi','policy'];
  if(Object.keys(inputs).length!==names.length||names.some(n=>!Object.hasOwn(inputs,n)))throw new Error('SERVICE_BAD_INPUT_PINS');
  const pinned=Object.fromEntries(names.map(n=>{const item=record(inputs[n]);
    if(typeof item.sha256!=='string'||!/^[a-f0-9]{64}$/.test(item.sha256))throw new Error('SERVICE_BAD_INPUT_PINS');
    return [n,{path:path(item.path),sha256:item.sha256}];}));
  let testnet:DeploymentProfile['testnet']=null;
  if(p.mode==='MONAD_TESTNET'){
    const t=record(p.testnet);uint(t.notAfterMs,64);
    if(BigInt(String(t.notAfterMs))===0n||typeof t.rpcEnv!=='string'||!/^[A-Za-z_][A-Za-z0-9_]*$/.test(t.rpcEnv))throw new Error('SERVICE_BAD_TESTNET_LIMIT');
    testnet={rpcEnv:t.rpcEnv,keysDirectory:path(t.keysDirectory),journalDirectory:path(t.journalDirectory),notAfterMs:t.notAfterMs as string,
      durationSeconds:integer(t.durationSeconds,1,86400),stopAfterFinalized:integer(t.stopAfterFinalized,1,100000)};
  }else if(p.testnet!==null)throw new Error('SERVICE_READ_ONLY_REQUIRED');
  return {schemaVersion:'1',mode:p.mode as DeploymentProfile['mode'],stateDirectory:path(p.stateDirectory),inputs:pinned,
    restart:{delayMs:integer(r.delayMs,1000,60000),maxRestarts:integer(r.maxRestarts,0,10),stopTimeoutMs:integer(r.stopTimeoutMs,1000,300000)},
    streamHints:p.streamHints,testnet};
}
export function loadDeploymentProfile(file:string):DeploymentProfile {
  try{return parseDeploymentProfile(JSON.parse(readFileSync(file,'utf8')));}catch(error){
    if(error instanceof Error&&/^SERVICE_[A-Z_]+$/.test(error.message))throw error;throw new Error('SERVICE_PROFILE_UNREADABLE');
  }
}
export function deploymentInputs(profile:DeploymentProfile):Record<string,unknown>{
  return Object.fromEntries(Object.entries(profile.inputs).map(([key,pin])=>{
    let bytes:Buffer;try{bytes=readFileSync(pin.path);}catch{throw new Error('SERVICE_INPUT_UNREADABLE');}
    if(bytes.length>2000000||sha(bytes)!==pin.sha256)throw new Error('SERVICE_INPUT_PIN_MISMATCH');
    try{return [key,JSON.parse(bytes.toString('utf8'))];}catch{throw new Error('SERVICE_INPUT_INVALID_JSON');}
  }));
}
function configs(profile:DeploymentProfile,inputs:Record<string,unknown>):MarketConfig[]{
  const raw=profile.mode==='READ_ONLY_COLLECTION'?inputs.configs:[inputs.config];
  if(!Array.isArray(raw)||!raw.length||raw.length>100)throw new Error('SERVICE_BAD_CONFIGS');
  const result=raw.map(parseConfig);ensureUniqueWorkers(result);
  if(result.some(c=>c.enabled)||(profile.mode==='READ_ONLY_COLLECTION'&&result.some(c=>c.destination!==null)))throw new Error('SERVICE_DISABLED_CONFIG_REQUIRED');
  if(profile.mode==='MONAD_TESTNET'&&result[0]!.destination?.chainId!=='10143')throw new Error('SERVICE_TESTNET_ONLY');
  return result;
}
const markerPath=(p:DeploymentProfile)=>join(p.stateDirectory,'service.json');
const sourcePath=(p:DeploymentProfile)=>p.mode==='READ_ONLY_COLLECTION'?join(p.stateDirectory,'source.sqlite'):join(p.testnet!.journalDirectory,'source.sqlite');
export function deploymentMarker(p:DeploymentProfile){const inputs=deploymentInputs(p);configs(p,inputs);
  return {schemaVersion:'1',mode:p.mode,inputs:p.inputs,testnet:p.testnet};}
/** Explicit bootstrap only. Restart never initializes a missing source/signing journal. */
export function prepareDeployment(p:DeploymentProfile):void {
  const marker=deploymentMarker(p);
  if(!existsSync(p.stateDirectory))mkdirSync(p.stateDirectory,{recursive:true,mode:0o700});
  testnetJournalPath(markerPath(p),true);testnetJournalPath(join(p.stateDirectory,'service.lock'),true);
  if(existsSync(markerPath(p))||existsSync(join(p.stateDirectory,'service.lock')))throw new Error('SERVICE_ALREADY_PREPARED');
  if(p.mode==='READ_ONLY_COLLECTION'){
    testnetJournalPath(sourcePath(p),true);if(existsSync(sourcePath(p)))throw new Error('SERVICE_EXISTING_ARCHIVE_REQUIRES_REVIEW');
    new Journal(sourcePath(p)).close();
  }else for(const name of ['source.sqlite','packets.sqlite','signer.sqlite','transactions.sqlite','relay.sqlite'])
    testnetJournalPath(join(p.testnet!.journalDirectory,name),false);
  // A partial preparation stays visible. There is no automated delete/adopt/reset.
  writeFileSync(join(p.stateDirectory,'service.lock'),'',{flag:'wx',mode:0o600});
  writeFileSync(join(p.stateDirectory,'supervision.json'),json(savedSupervision({phase:'STOPPED',restarts:0,reason:null}))+'\n',{flag:'wx',mode:0o600});
  const preparedAtMs=BigInt(Date.now());
  const ceiling=p.testnet?preparedAtMs+BigInt(p.testnet.durationSeconds)*1000n:null;
  const deadline=ceiling===null?null:ceiling<BigInt(p.testnet!.notAfterMs)?ceiling:BigInt(p.testnet!.notAfterMs);
  writeFileSync(markerPath(p),json({...marker,preparedAtMs:preparedAtMs.toString(),campaignDeadlineMs:deadline?.toString()??null})+'\n',{flag:'wx',mode:0o600});
  for(const file of [sourcePath(p),join(p.stateDirectory,'service.lock'),join(p.stateDirectory,'supervision.json'),markerPath(p)]){
    const fd=openSync(file,constants.O_RDONLY|constants.O_NOFOLLOW);try{fsyncSync(fd);}finally{closeSync(fd);}}
  const fd=openSync(p.stateDirectory,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);try{fsyncSync(fd);}finally{closeSync(fd);}
}
export function checkDeployment(p:DeploymentProfile):MarketConfig[]{
  const input=deploymentInputs(p),cfg=configs(p,input);
  for(const file of [markerPath(p),join(p.stateDirectory,'service.lock'),join(p.stateDirectory,'supervision.json'),sourcePath(p)])testnetJournalPath(file,false);
  let marker:unknown;try{marker=JSON.parse(readFileSync(markerPath(p),'utf8'));}catch{throw new Error('SERVICE_MARKER_UNREADABLE');}
  const saved=record(marker);uint(saved.preparedAtMs,64);
  if(json(marker)!==json({...deploymentMarker(p),preparedAtMs:saved.preparedAtMs,campaignDeadlineMs:saved.campaignDeadlineMs}))throw new Error('SERVICE_MARKER_MISMATCH');
  if(!p.testnet&&saved.campaignDeadlineMs!==null)throw new Error('SERVICE_MARKER_MISMATCH');
  if(p.testnet){
    uint(saved.campaignDeadlineMs,64);const deadline=BigInt(String(saved.campaignDeadlineMs));
    if(deadline>BigInt(p.testnet.notAfterMs)||deadline>BigInt(String(saved.preparedAtMs))+BigInt(p.testnet.durationSeconds)*1000n)
      throw new Error('SERVICE_MARKER_MISMATCH');
    if(deadline<=BigInt(Date.now()))throw new Error('SERVICE_CAMPAIGN_EXPIRED');
    for(const name of ['packets.sqlite','signer.sqlite','transactions.sqlite','relay.sqlite'])testnetJournalPath(join(p.testnet.journalDirectory,name),false);
  }
  const journal=new Journal(sourcePath(p),true);
  try{
    if(!journal.verify())throw new Error('SERVICE_ARCHIVE_INTEGRITY');
    for(const c of cfg){const previous=journal.latest(workerNamespace(c))?.payload;
      if(previous&&previous.configDigest!==sha(json(c)))throw new Error('SERVICE_ARCHIVE_CONFIG_MISMATCH');
      if(previous&&record(previous.inspection).status==='QUARANTINED')throw new Error('SERVICE_SOURCE_QUARANTINED');}
  }finally{journal.close();}
  return cfg;
}
/** Fixed-path private lock is kept on fd 3 by flock, supervisor AND worker. */
export function openDeploymentLock(p:DeploymentProfile):number {
  const file=testnetJournalPath(join(p.stateDirectory,'service.lock'),false),stat=lstatSync(file);
  if((stat.mode&0o077)!==0)throw new Error('SERVICE_PRIVATE_LOCK_REQUIRED');
  return openSync(file,constants.O_RDWR|constants.O_NOFOLLOW);
}
export function sourceLeaseWaitMs(p:DeploymentProfile):bigint {
  const db=new DatabaseSync(sourcePath(p),{readOnly:true});
  try{return db.prepare('SELECT until_ms FROM writers').all().reduce((max,row)=>{
    const left=BigInt(String(row.until_ms))-BigInt(Date.now());return left>max?left:max;},0n);}finally{db.close();}
}
export const deploymentSourcePath=sourcePath;
export function deploymentDeadline(p:DeploymentProfile):bigint|null {
  const marker=record(JSON.parse(readFileSync(markerPath(p),'utf8')));return marker.campaignDeadlineMs===null?null:BigInt(String(marker.campaignDeadlineMs));
}
export type SupervisionState={phase:'STOPPED'|'RUNNING'|'OPERATOR_STOP';restarts:number;reason:string|null};
function savedSupervision(state:SupervisionState){return {state,sha256:sha(json(state))};}
export function readSupervision(p:DeploymentProfile):SupervisionState {
  const file=testnetJournalPath(join(p.stateDirectory,'supervision.json'),false);
  let raw,s;try{raw=record(JSON.parse(readFileSync(file,'utf8')));s=record(raw.state);}catch{throw new Error('SERVICE_SUPERVISION_INTEGRITY');}
  if(!['STOPPED','RUNNING','OPERATOR_STOP'].includes(String(s.phase))||!Number.isSafeInteger(s.restarts)||Number(s.restarts)<0
    ||Number(s.restarts)>11||s.reason!==null&&(typeof s.reason!=='string'||!/^[A-Z][A-Z0-9_]+$/.test(s.reason))
    ||sha(json(s))!==raw.sha256)throw new Error('SERVICE_SUPERVISION_INTEGRITY');
  return s as SupervisionState;
}
/** Called only while holding the inherited OFD lock. Private temp + fsync + atomic rename. */
export function writeSupervision(p:DeploymentProfile,state:SupervisionState):void {
  const file=testnetJournalPath(join(p.stateDirectory,'supervision.json'),false),temp=join(p.stateDirectory,`.supervision-${randomUUID()}.tmp`);
  const fd=openSync(temp,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
  try{writeFileSync(fd,json(savedSupervision(state))+'\n');fsyncSync(fd);}finally{closeSync(fd);}
  renameSync(temp,file);const parent=openSync(p.stateDirectory,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);
  try{fsyncSync(parent);}finally{closeSync(parent);}
}
