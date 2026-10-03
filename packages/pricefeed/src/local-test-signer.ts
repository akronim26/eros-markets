import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { privateKeyToAccount } from 'viem/accounts';
import type { Hex } from 'viem';
import { PacketStore, packetNamespace, type PacketDomain } from './packet-store.js';
import type { RawSigner, SignRequest } from './publication.js';

const checksum=(body:string)=>createHash('sha256').update(body).digest('hex');
/** Public fixture key only, local chain only. This is not a production key backend. */
export class LocalTestSigner implements RawSigner {
  private readonly db:DatabaseSync;
  private readonly account=privateKeyToAccount(('0x'+'11'.repeat(32)) as Hex);
  readonly address=this.account.address;
  private readonly namespace:string;
  constructor(path:string,private readonly domain:PacketDomain,private readonly store:PacketStore,private readonly now:()=>bigint){
    if(domain.chainId!==31337n||domain.signer.toLowerCase()!==this.address.toLowerCase())throw new Error('PUBLIC_LOCAL_TEST_SIGNER_ONLY');
    this.namespace=packetNamespace(domain);
    this.db=new DatabaseSync(path,{timeout:1000});
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS signer_fences(ns TEXT PRIMARY KEY,owner TEXT NOT NULL,fence INTEGER NOT NULL) STRICT;
      CREATE TABLE IF NOT EXISTS signer_reservations(identity TEXT PRIMARY KEY,ns TEXT NOT NULL,sequence TEXT NOT NULL,digest TEXT NOT NULL,signature TEXT,sha256 TEXT NOT NULL) STRICT;`);
    for(const r of this.db.prepare('SELECT * FROM signer_reservations').all())
      if(checksum(`${r.identity}:${r.digest}:${r.signature??''}`)!==r.sha256){this.db.close();throw new Error('SIGNER_JOURNAL_INTEGRITY');}
  }
  private tx<T>(fn:()=>T):T {this.db.exec('BEGIN IMMEDIATE');try{const value=fn();this.db.exec('COMMIT');return value;}catch(e){this.db.exec('ROLLBACK');throw e;}}
  reservations():{sequence:bigint;digest:Hex}[] {
    return this.db.prepare('SELECT sequence,digest FROM signer_reservations WHERE ns=?').all(this.namespace)
      .map(r=>({sequence:BigInt(String(r.sequence)),digest:r.digest as Hex}));
  }
  reconcile(owner:string,fence:bigint,chain:{lastSequence:bigint;lastObservedAt:bigint}):void {
    this.store.reconcile(this.domain,owner,fence,this.now(),chain,this.reservations());
  }
  async signDigest(request:SignRequest):Promise<Hex> {
    this.store.assertWriter(this.domain,request.owner,request.fence,this.now());
    const prefix=this.namespace+':';
    if(!request.identity.startsWith(prefix)||!/^0x[0-9a-fA-F]{64}$/.test(request.digest))throw new Error('SIGNER_DOMAIN_MISMATCH');
    const sequence=BigInt(request.identity.slice(prefix.length));
    if(sequence<=0n||sequence>=(1n<<64n)||request.identity!==prefix+sequence)throw new Error('SIGNER_IDENTITY_MISMATCH');
    const packet=this.store.get(this.domain,sequence);
    if(!packet||packet.digest!==request.digest||packet.state!=='SIGNING')throw new Error('SIGNER_PACKET_MISMATCH');
    const cached=this.tx(()=>{
      const q=this.db.prepare('SELECT * FROM signer_fences WHERE ns=?');q.setReadBigInts(true);const row=q.get(this.namespace);
      if(row&&(BigInt(String(row.fence))>request.fence||(BigInt(String(row.fence))===request.fence&&row.owner!==request.owner)))throw new Error('SIGNER_FENCED');
      this.db.prepare('INSERT INTO signer_fences VALUES(?,?,?) ON CONFLICT(ns) DO UPDATE SET owner=excluded.owner,fence=excluded.fence').run(this.namespace,request.owner,request.fence);
      const existing=this.db.prepare('SELECT * FROM signer_reservations WHERE identity=?').get(request.identity);
      if(existing){
        if(existing.digest!==request.digest||checksum(`${existing.identity}:${existing.digest}:${existing.signature??''}`)!==existing.sha256)throw new Error('SIGNER_IDENTITY_CONFLICT');
        return existing.signature as Hex|null;
      }
      this.db.prepare('INSERT INTO signer_reservations VALUES(?,?,?,?,NULL,?)').run(request.identity,this.namespace,sequence.toString(),request.digest,checksum(`${request.identity}:${request.digest}:`));
      return null;
    });
    if(cached)return cached;
    const signature=await this.account.sign({hash:request.digest});
    // A crash after reservation retries the same deterministic raw signature.
    this.store.assertWriter(this.domain,request.owner,request.fence,this.now());
    this.tx(()=>{
      this.db.prepare('UPDATE signer_reservations SET signature=?,sha256=? WHERE identity=? AND digest=?').run(signature,checksum(`${request.identity}:${request.digest}:${signature}`),request.identity,request.digest);
    });
    return signature;
  }
  close():void {this.db.close();}
}
