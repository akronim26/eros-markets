import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const stages=['COLLECTED','ALLOCATED','SIGNING','SIGNER_RESERVED','SIGNER_SIGNED','SIGNED',
  'PREPARING','TX_SIGNED','READY','UNKNOWN','BROADCAST','MINED','FINALIZED'];
const env={...process.env};delete env.NODE_TEST_CONTEXT;
const run=(dir:string,mode:string,stage:string)=>spawnSync(process.execPath,
  [fileURLToPath(new URL('./recovery-child.js',import.meta.url)),dir,mode,stage],
  {env,encoding:'utf8',timeout:15000});
function inventory(dir:string) {
  const db=new DatabaseSync(join(dir,'packets.sqlite'),{readOnly:true});
  try{return db.prepare('SELECT body,digest,signature,state FROM packets ORDER BY length(sequence),sequence').all();}
  finally{db.close();}
}
for(const stage of stages)test(`SIGKILL at ${stage} preserves identities and resumes two ordered deliveries`,()=>{
  const dir=mkdtempSync(join(tmpdir(),'pricefeed-crash-'));try{
    const killed=run(dir,'crash',stage);assert.equal(killed.signal,'SIGKILL',killed.stderr);
    assert.equal(JSON.parse(killed.stdout).crashedAt,stage);
    const before=inventory(dir);
    if(stage==='SIGNER_RESERVED'||stage==='SIGNER_SIGNED'){
      const db=new DatabaseSync(join(dir,'signer.sqlite'),{readOnly:true});try{
        const reserved=db.prepare('SELECT signature FROM signer_reservations').get()!;
        if(stage==='SIGNER_RESERVED')assert.equal(reserved.signature,null);
        else assert.match(String(reserved.signature),/^0x[0-9a-f]{130}$/);
      }finally{db.close();}
    }
    const resumed=run(dir,'resume',stage);assert.equal(resumed.status,0,resumed.stderr);
    const report=JSON.parse(resumed.stdout);
    assert.deepEqual(report.sequences,['1','2']);assert.deepEqual(report.nonces,['0','1']);
    assert.equal(report.broadcastCalls,2);assert.equal(report.finalState,'FINALIZED');
    assert.equal(report.sourceEvidenceValid,true);assert.equal(report.packetEvidenceValid,true);
    assert.equal(report.externalTransactions,0);assert.equal(report.source,'scripted fixture');
    const after=inventory(dir);
    if(before[0]){
      assert.equal(after[0]!.body,before[0].body);assert.equal(after[0]!.digest,before[0].digest);
      if(before[0].signature)assert.equal(after[0]!.signature,before[0].signature);
    }
    assert.equal(report.transactionReservations,2);assert.equal(report.immutableTransactionRetry,true);
    console.log('RECOVERY_CASE '+JSON.stringify({stage,...report}));
  }finally{rmSync(dir,{recursive:true,force:true});}
});

test('crashed writer lease prevents immediate restart rather than forcing takeover',()=>{
  const dir=mkdtempSync(join(tmpdir(),'pricefeed-lease-crash-'));try{
    assert.equal(run(dir,'crash','SIGNED').signal,'SIGKILL');
    const early=run(dir,'early','SIGNED');assert.equal(early.status,1);assert.match(early.stderr,/WRITER_BUSY/);
    assert.equal(inventory(dir).length,1);assert.equal(run(dir,'resume','SIGNED').status,0);
  }finally{rmSync(dir,{recursive:true,force:true});}
});

test('restored old packet snapshot is blocked by signer reservations surviving SIGKILL',()=>{
  for(const stage of ['SIGNER_RESERVED','SIGNER_SIGNED','SIGNED']){
    const dir=mkdtempSync(join(tmpdir(),'pricefeed-restore-crash-'));try{
      assert.equal(run(dir,'crash',stage).signal,'SIGKILL');
      const restored=run(dir,'restore-packets',stage);assert.equal(restored.status,1);assert.match(restored.stderr,/SIGNER_JOURNAL_AHEAD_OR_MISMATCH/);
      const db=new DatabaseSync(join(dir,'restored-packets.sqlite'),{readOnly:true});
      try{assert.equal(db.prepare('SELECT count(*) AS n FROM packets').get()!.n,0);}finally{db.close();}
    }finally{rmSync(dir,{recursive:true,force:true});}
  }
});

test('restored relay snapshot behind accepted nonce cannot reserve or broadcast again',()=>{
  const dir=mkdtempSync(join(tmpdir(),'pricefeed-relay-restore-'));try{
    assert.equal(run(dir,'crash','BROADCAST').signal,'SIGKILL');
    const restored=run(dir,'restore-relay','BROADCAST');assert.equal(restored.status,1);assert.match(restored.stderr,/UNKNOWN_RELAY_NONCE/);
    const db=new DatabaseSync(join(dir,'counterpart.sqlite'),{readOnly:true});
    try{assert.equal(db.prepare('SELECT sum(calls) AS n FROM sends').get()!.n,1);}finally{db.close();}
  }finally{rmSync(dir,{recursive:true,force:true});}
});

test('restart cannot refresh an expired signed packet or broadcast its reserved transaction',()=>{
  for(const stage of ['PREPARING','READY','UNKNOWN']){
  const dir=mkdtempSync(join(tmpdir(),'pricefeed-expiry-crash-'));try{
    assert.equal(run(dir,'crash',stage).signal,'SIGKILL');const before=inventory(dir)[0]!;
    const expired=run(dir,'expired',stage);assert.equal(expired.status,1);assert.match(expired.stderr,/HEADROOM_EXPIRED/);
    assert.equal(inventory(dir)[0]!.body,before.body);
    const relay=new DatabaseSync(join(dir,'relay.sqlite'),{readOnly:true});try{
      const delivery=JSON.parse(String(relay.prepare('SELECT body FROM deliveries').get()!.body));
      assert.equal(delivery.state,'QUARANTINED');assert.equal(delivery.reason,'RESERVED_NONCE_HEADROOM_EXPIRED');
      assert.equal(delivery.nonce,'0');
    }finally{relay.close();}
    const db=new DatabaseSync(join(dir,'counterpart.sqlite'),{readOnly:true});
    try{assert.equal(db.prepare('SELECT count(*) AS n FROM sends').get()!.n,0);}finally{db.close();}
  }finally{rmSync(dir,{recursive:true,force:true});}
  }
});
