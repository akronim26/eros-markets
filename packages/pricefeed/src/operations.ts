import { createHash } from 'node:crypto';
import { readFileSync, statfsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { record } from './book.js';
import { parseConfig } from './config.js';
import { checkDeployment, deploymentInputs, deploymentSourcePath, loadDeploymentProfile, readSupervision } from './deployment.js';
import { healthView } from './health.js';
import { Journal } from './journal.js';
import { json, uint } from './math.js';
import { testnetJournalPath } from './monad-keys.js';
import { workerNamespace } from './worker.js';
import { recoveryBudget } from './nonce-recovery-journal.js';
import { verifyBudgetAudit } from './relay-policy.js';

export type OperationsSettings={schemaVersion:'1';intervalMs:number;maxCaptureSilenceMs:bigint;minimumFreeBytes:bigint;
  maximumPendingDeliveries:number;maxReceiptSilenceMs:bigint;minimumBudgetRemainingWei:bigint;maxBackupAgeMs:bigint;
  backup:{directory:string;manifestSha256:string}|null};
export type OperationsAlert={code:string;worker:string|null};
export const operationsLog=(event:unknown)=>JSON.stringify(event,(_key,value:unknown)=>typeof value==='bigint'?value.toString():value);
export function parseOperationsSettings(value:unknown):OperationsSettings {
  const p=record(value);
  if(p.schemaVersion!=='1'||!Number.isSafeInteger(p.intervalMs)||Number(p.intervalMs)<1000||Number(p.intervalMs)>60000
    ||!Number.isSafeInteger(p.maximumPendingDeliveries)||Number(p.maximumPendingDeliveries)<0)throw new Error('OPS_BAD_SETTINGS');
  let backup:OperationsSettings['backup']=null;
  if(p.backup!==null){const b=record(p.backup);
    if(typeof b.directory!=='string'||!b.directory.startsWith('/')||typeof b.manifestSha256!=='string'||!/^[a-f0-9]{64}$/.test(b.manifestSha256))throw new Error('OPS_BAD_BACKUP_PIN');
    backup={directory:b.directory,manifestSha256:b.manifestSha256};}
  const maxCaptureSilenceMs=uint(p.maxCaptureSilenceMs,64),maxReceiptSilenceMs=uint(p.maxReceiptSilenceMs,64),maxBackupAgeMs=uint(p.maxBackupAgeMs,64);
  if(!maxCaptureSilenceMs||!maxReceiptSilenceMs||!maxBackupAgeMs)throw new Error('OPS_BAD_SETTINGS');
  return {schemaVersion:'1',intervalMs:Number(p.intervalMs),maxCaptureSilenceMs,minimumFreeBytes:uint(p.minimumFreeBytes,64),
    maximumPendingDeliveries:Number(p.maximumPendingDeliveries),maxReceiptSilenceMs,minimumBudgetRemainingWei:uint(p.minimumBudgetRemainingWei,256),maxBackupAgeMs,backup};
}
const sha=(body:string|Buffer)=>createHash('sha256').update(body).digest('hex');
const fixed=(error:unknown)=>error instanceof Error&&/^[A-Z][A-Z0-9_]+$/.test(error.message)?error.message:'OPS_READ_FAILED';
function readDb(path:string){return new DatabaseSync(testnetJournalPath(path,false),{readOnly:true,timeout:1000});}
function records(db:DatabaseSync,table:string):Record<string,unknown>[] {
  return db.prepare(`SELECT body,sha256 FROM ${table}`).all().map(row=>{
    if(sha(String(row.body))!==row.sha256)throw new Error('OPS_RECORD_INTEGRITY');return record(JSON.parse(String(row.body)));
  });
}
/** Cached, read-only operator status. Never performs RPC, unlocks keys or clears state. */
export function operationsHealth(profileFile:string,settings:OperationsSettings,nowMs=BigInt(Date.now())) {
  const profile=loadDeploymentProfile(profileFile),alerts:OperationsAlert[]=[];
  const alert=(code:string,worker:string|null=null)=>alerts.push({code,worker});
  const read=<T>(fn:()=>T):T|null=>{try{return fn();}catch(error){alert(fixed(error));return null;}};
  const supervision=read(()=>readSupervision(profile));
  if(supervision&&supervision.phase!=='RUNNING')alert(supervision.phase==='OPERATOR_STOP'?'OPS_OPERATOR_STOP':'OPS_SERVICE_STOPPED');
  const deploymentValid=read(()=>checkDeployment(profile));
  const input=read(()=>deploymentInputs(profile));
  const workers:Record<string,unknown>[]=[],lifecycle:Record<string,unknown>[]=[];
  if(input)read(()=>{
    const configs=(profile.mode==='READ_ONLY_COLLECTION'?input.configs:[input.config]) as unknown[];
    const journal=new Journal(testnetJournalPath(deploymentSourcePath(profile),false),true);
    try{
      for(const raw of configs){const cfg=parseConfig(raw),namespace=workerNamespace(cfg),latest=journal.latest(namespace);
        if(!latest){alert('OPS_NO_SOURCE_CAPTURE',namespace);workers.push({worker:namespace,currentStatus:'UNAVAILABLE',lastCaptureAtMs:null,freshAtQuery:false});continue;}
        const health=healthView(latest.payload,nowMs),silenceMs=nowMs-latest.atMs;
        if(silenceMs<0n)alert('OPS_CAPTURE_CLOCK_FUTURE',namespace);
        else if(silenceMs>settings.maxCaptureSilenceMs)alert('OPS_SOURCE_SILENT',namespace);
        if(health.currentStatus!=='COLLECTING'||!health.freshAtQuery)alert('OPS_SOURCE_UNAVAILABLE',namespace);
        workers.push({...health,captureSilenceMs:silenceMs});
      }
      for(const namespace of journal.workers()){const payload=journal.latest(namespace)!.payload;
        if(payload.recordType==='LIFECYCLE'){const health=healthView(payload,nowMs);lifecycle.push(health);
          if(!health.freshAtQuery||!['COLLECTING','RECORD_ONLY'].includes(String(health.currentStatus)))alert('OPS_LIFECYCLE_UNAVAILABLE',namespace);}}
    }finally{journal.close();}
  });
  const storage=read(()=>[...new Set([profile.stateDirectory,...(profile.testnet?[profile.testnet.journalDirectory]:[])])].map(path=>{
    const s=statfsSync(path,{bigint:true}),availableBytes=s.bavail*s.bsize;
    if(availableBytes<settings.minimumFreeBytes)alert('OPS_DISK_LOW');return {availableBytes,minimumFreeBytes:settings.minimumFreeBytes};}));
  let publication:Record<string,unknown>|null=null;
  if(profile.testnet)publication=read(()=>{
    const root=profile.testnet!.journalDirectory,db=readDb(join(root,'relay.sqlite'));
    try{
      const control=db.prepare('SELECT profile,reason FROM relay_control WHERE id=1').get();
      if(!control)throw new Error('OPS_RELAY_CONTROL_MISSING');
      if(control.reason)alert('OPS_RELAY_QUARANTINED');
      const relayProfile=record(JSON.parse(String(control.profile)));verifyBudgetAudit(db,String(control.profile),Number(relayProfile.budgetRevision??0));
      const deliveries=records(db,'deliveries'),recovery=recoveryBudget(db),byState:Record<string,number>={};
      for(const d of deliveries){const state=String(d.state);byState[state]=(byState[state]??0)+1;
        if(['QUARANTINED','ORPHANED','REVERTED'].includes(state))alert('OPS_DELIVERY_'+state);}
      const pending=deliveries.filter(d=>!['FINALIZED','CANCELLED','REVERTED'].includes(String(d.state))).length;
      if(pending>settings.maximumPendingDeliveries)alert('OPS_PUBLICATION_BACKLOG');
      const accepted=deliveries.filter(d=>d.state==='FINALIZED'&&d.accepted).map(d=>record(d.accepted))
        .sort((a,b)=>BigInt(String(a.acceptedAt))<BigInt(String(b.acceptedAt))?1:-1);
      const last=accepted[0]??null,ageMs=last?nowMs-BigInt(String(last.acceptedAt))*1000n:null;
      if(ageMs===null||ageMs<0n||ageMs>settings.maxReceiptSilenceMs)alert('OPS_RECEIPT_PROGRESS_UNAVAILABLE');
      const reservationCount=deliveries.length+recovery.count;
      const reservedWei=deliveries.reduce((sum,d)=>sum+(d.request?BigInt(String(record(d.request).gas))*BigInt(String(record(d.request).maxFeePerGas)):
        BigInt(String(record(relayProfile.relayPolicy).maxCostWei))),0n)+recovery.reservedWei;
      const remainingReservations=Number(relayProfile.maxTransactions)-reservationCount,remainingReservationWei=BigInt(String(relayProfile.totalMaxCostWei))-reservedWei;
      if(remainingReservations<=0||remainingReservationWei<=0n)alert('OPS_BUDGET_EXHAUSTED');
      else if(remainingReservationWei<settings.minimumBudgetRemainingWei)alert('OPS_BUDGET_LOW');
      return {byState,pendingDeliveries:pending,reservationCount,reservedWei,remainingReservations,remainingReservationWei,
        lastFinalizedReceipt:last?{blockNumber:last.blockNumber,blockHash:last.blockHash,acceptedAt:last.acceptedAt,depthValid:last.depthValid}:null,
        receiptSilenceMs:ageMs,chainQueried:false,walletBalanceWei:null,indexTwap300:null};
    }finally{db.close();}
  });
  const backup=read(()=>{
    if(!settings.backup){alert('OPS_BACKUP_NOT_CONFIGURED');return null;}
    const b=settings.backup,bytes=readFileSync(testnetJournalPath(join(b.directory,'manifest.json'),false));
    if(sha(bytes)!==b.manifestSha256)throw new Error('OPS_BACKUP_PIN_MISMATCH');
    const saved=record(JSON.parse(bytes.toString())),ageMs=nowMs-uint(saved.createdAtMs,64);
    if(record(saved.files)['control/profile.json']!==sha(readFileSync(profileFile)))alert('OPS_BACKUP_PROFILE_MISMATCH');
    if(saved.mode!==profile.mode||profile.testnet&&saved.custodyIncluded!==true)alert('OPS_BACKUP_INCOMPLETE_FOR_SERVICE');
    if(ageMs<0n||ageMs>settings.maxBackupAgeMs)alert('OPS_BACKUP_STALE');
    const checked=spawnSync('python3',[fileURLToPath(new URL('../../scripts/backup-journals.py',import.meta.url)), 'verify',b.directory,b.manifestSha256],
      {encoding:'utf8',timeout:10000,maxBuffer:4096});
    if(checked.status!==0)alert('OPS_BACKUP_VERIFICATION_FAILED');
    return {ageMs,verified:checked.status===0,custodyIncluded:saved.custodyIncluded===true};
  });
  return {event:'OPERATIONS_HEALTH',atMs:nowMs,mode:profile.mode,healthy:alerts.length===0,
    collectionHealthy:deploymentValid!==null&&supervision?.phase==='RUNNING'&&workers.length>0&&workers.every(w=>w.currentStatus==='COLLECTING'&&w.freshAtQuery===true)&&!alerts.some(a=>a.code==='OPS_SOURCE_SILENT'||a.code==='OPS_CAPTURE_CLOCK_FUTURE'),
    supervision,workers,lifecycle,storage,publication,backup,alerts,operationalOutput:false,productionApproved:false};
}
export class AlertTransitions {
  private active=new Map<string,OperationsAlert>();
  update(alerts:OperationsAlert[],atMs:bigint){
    const next=new Map(alerts.map(a=>[json(a),a])),events:Record<string,unknown>[]=[];
    for(const [key,a] of next)if(!this.active.has(key))events.push({event:'ALERT_OPEN',atMs,...a});
    for(const [key,a] of this.active)if(!next.has(key))events.push({event:'ALERT_CLEARED',atMs,...a});
    this.active=next;return events;
  }
}
export async function watchOperations(profile:string,settings:OperationsSettings,signal:AbortSignal,emit:(event:unknown)=>void){
  const transitions=new AlertTransitions();
  while(!signal.aborted){
    try{const health=operationsHealth(profile,settings);emit(health);for(const event of transitions.update(health.alerts,health.atMs))emit(event);}
    catch(error){const alerts=[{code:fixed(error),worker:null}];emit({event:'OPERATIONS_HEALTH',healthy:false,alerts,operationalOutput:false});
      for(const event of transitions.update(alerts,BigInt(Date.now())))emit(event);}
    await new Promise<void>(resolve=>{const done=()=>{clearTimeout(timer);signal.removeEventListener('abort',done);resolve();};
      const timer=setTimeout(done,settings.intervalMs);signal.addEventListener('abort',done,{once:true});if(signal.aborted)done();});
  }
}
