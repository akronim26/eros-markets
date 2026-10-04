import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { privateKeyToAccount } from 'viem/accounts';
import type { Hex } from 'viem';
import { LocalTestSigner } from '../src/local-test-signer.js';
import { PacketStore, packetNamespace } from '../src/packet-store.js';
import { candidate } from './publication-fixture.js';

const sha=(s:string)=>createHash('sha256').update(s).digest('hex');
async function fixture(){
  const dir=mkdtempSync(join(tmpdir(),'pricefeed-custody-')),path=join(dir,'signer.sqlite'),store=new PacketStore(join(dir,'packets.sqlite'));
  const domain=candidate(1n).domain,owner='owner',now=1000100n,fence=store.acquire(domain,owner,now,10000n);
  store.reconcile(domain,owner,fence,now,{lastSequence:0n,lastObservedAt:0n});store.allocate(domain,owner,fence,now,s=>candidate(s));
  const packet=store.beginSign(domain,owner,fence,now,1n),request={identity:packetNamespace(domain)+':1',digest:packet.digest,owner,fence};
  const signer=new LocalTestSigner(path,domain,store,()=>now),signature=await signer.signDigest(request);
  const rewrite=(change:Record<string,unknown>)=>{
    const db=new DatabaseSync(path);try{
      const r={...db.prepare('SELECT * FROM signer_reservations').get()!,...change};
      db.prepare('UPDATE signer_reservations SET identity=?,ns=?,sequence=?,digest=?,signature=?,sha256=?')
        .run(String(r.identity),String(r.ns),String(r.sequence),String(r.digest),r.signature===null?null:String(r.signature),sha(`${r.identity}:${r.digest}:${r.signature??''}`));
    }finally{db.close();}
  };
  return {dir,path,store,domain,signer,signature,request,rewrite,close:()=>{signer.close();store.close();rmSync(dir,{recursive:true,force:true});}};
}
test('retained signatures are cryptographically checked on restart and cached identity retries',async()=>{
  const f=await fixture();try{
    await f.signer.verifyJournal();assert.equal(await f.signer.signDigest(f.request),f.signature);
    const wrong=await privateKeyToAccount(('0x'+'33'.repeat(32)) as Hex).sign({hash:f.request.digest});
    f.rewrite({signature:wrong});
    // Recomputed integrity hashes cannot turn a different key into the approved signer.
    await assert.rejects(f.signer.verifyJournal(),/SIGNER_JOURNAL_SIGNATURE_MISMATCH/);
    await assert.rejects(f.signer.signDigest(f.request),/SIGNER_JOURNAL_SIGNATURE_MISMATCH/);
    const reopened=new LocalTestSigner(f.path,f.domain,f.store,()=>1000100n);
    try{await assert.rejects(reopened.verifyJournal(),/SIGNER_JOURNAL_SIGNATURE_MISMATCH/);}finally{reopened.close();}
    f.rewrite({signature:f.signature});assert.equal(await f.signer.signDigest(f.request),f.signature);
  }finally{f.close();}
});
test('malformed/high-s/recovery-byte signatures and mismatched sequence identities fail despite fresh checksums',async()=>{
  const n=0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
  for(const change of [{signature:'0xdead'},{signature:'0x'+'01'.repeat(32)+(n-1n).toString(16).padStart(64,'0')+'1b'},
    {signature:'0x'+'01'.repeat(64)+'00'},{sequence:'2'},{identity:'wrong:1'},{sequence:'18446744073709551616'}]){
    const f=await fixture();try{
      f.rewrite(change);await assert.rejects(f.signer.verifyJournal(),/SIGNER_JOURNAL_INTEGRITY/);
      assert.throws(()=>new LocalTestSigner(f.path,f.domain,f.store,()=>1000100n),/SIGNER_JOURNAL_INTEGRITY/);
    }finally{f.close();}
  }
});
test('a restored journal with a corrupted checksum cannot reuse previously verified cached signatures',async()=>{
  const f=await fixture();try{
    await f.signer.verifyJournal();const db=new DatabaseSync(f.path);
    db.prepare('UPDATE signer_reservations SET sha256=?').run('bad');db.close();
    await assert.rejects(f.signer.verifyJournal(),/SIGNER_JOURNAL_INTEGRITY/);
    await assert.rejects(f.signer.signDigest(f.request),/SIGNER_JOURNAL_INTEGRITY/);
  }finally{f.close();}
});
