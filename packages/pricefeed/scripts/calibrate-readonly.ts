import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { Journal } from '../src/journal.js';
import { parseConfig } from '../src/config.js';
import { parseCalibrationPlan, calibrate } from '../src/calibration.js';
import { workerNamespace, type PollResult } from '../src/worker.js';
import { json } from '../src/math.js';

// Reproducible offline analysis of a completed read-only soak; never replaces its collector report.
function main(){
  const [configPath,planPath,dbPath,soakPath,outPath,...extra]=process.argv.slice(2);
  if(!configPath||!planPath||!dbPath||!soakPath||!outPath||extra.length||existsSync(outPath))throw new Error('BAD_CALIBRATION_ARGUMENTS');
  const configs=JSON.parse(readFileSync(configPath,'utf8')).map(parseConfig),plan=parseCalibrationPlan(JSON.parse(readFileSync(planPath,'utf8')));
  const soak=JSON.parse(readFileSync(soakPath,'utf8'));
  const archiveHash=createHash('sha256').update(readFileSync(dbPath)).digest('hex');
  if(soak.mode!=='READ_ONLY_CATEGORY_CALIBRATION'||soak.sourceArchiveSha256!==archiveHash
    ||soak.configsSha256!==createHash('sha256').update(json(configs)).digest('hex')||json(soak.plan)!==json(plan)
    ||soak.signaturesProduced!==0||soak.transactionsSent!==0||soak.productionApproved!==false||soak.engineCoverageCertified!==false)
    throw new Error('CALIBRATION_SOAK_PROVENANCE_MISMATCH');
  const archive=new Journal(dbPath,true);let rows:PollResult[];
  try{
    if(!archive.verify())throw new Error('CALIBRATION_ARCHIVE_CHECKSUM');
    rows=configs.flatMap((c:ReturnType<typeof parseConfig>)=>archive.read(workerNamespace(c)).map(r=>{
      const p=r.payload;
      for(const field of ['event','metadata','book'] as const){const capture=p[field] as Record<string,unknown>|null;
        if(capture){capture.receivedAtMs=BigInt(String(capture.receivedAtMs));capture.latencyMs=BigInt(String(capture.latencyMs));}}
      return {...p,atMs:r.atMs} as unknown as PollResult;
    }));
  }finally{archive.close();}
  const report={...calibrate(configs,plan,rows,BigInt(soak.completedAtMs)),sourceArchiveSha256:archiveHash,
    configsSha256:soak.configsSha256,collectorReportSha256:createHash('sha256').update(readFileSync(soakPath)).digest('hex')};
  mkdirSync(dirname(outPath),{recursive:true});writeFileSync(outPath,json(report)+'\n',{flag:'wx'});
  console.log('PASS: offline raw-book calibration; no engine coverage or production approval');
}
try{main();}catch{console.error('READ_ONLY_CALIBRATION_FAILED');process.exitCode=1;}
