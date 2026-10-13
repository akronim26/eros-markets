import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import type { PrivateKeyAccount } from 'viem/accounts';
import { recoverAddress, type Hex } from 'viem';
import { PacketStore, packetNamespace, type PacketDomain } from './packet-store.js';
import { canonicalSignature, type RawSigner, type SignRequest } from './publication.js';

const checksum=(body:string)=>createHash('sha256').update(body).digest('hex');
/** Shared durable signing mechanics. Fixed-network wrappers select the key backend. */
export class DurableObservationSigner implements RawSigner {
  private readonly db:DatabaseSync;
  readonly address:string;
  private readonly namespace:string;
  private readonly verified=new Set<string>();
  protected constructor(path:string,private readonly domain:PacketDomain,private readonly store:PacketStore,private readonly now:()=>bigint,
    private readonly account:PrivateKeyAccount,private readonly chainId:31337n|10143n){
    this.address=account.address;
    if(domain.chainId!==chainId||domain.signer.toLowerCase()!==this.address.toLowerCase())throw new Error('PUBLIC_LOCAL_TEST_SIGNER_ONLY');
    this.namespace=packetNamespace(domain);
    this.db=new DatabaseSync(path,{timeout:1000});
    try{this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS signer_fences(ns TEXT PRIMARY KEY,owner TEXT NOT NULL,fence INTEGER NOT NULL) STRICT;
      CREATE TABLE IF NOT EXISTS signer_reservations(identity TEXT PRIMARY KEY,ns TEXT NOT NULL,sequence TEXT NOT NULL,digest TEXT NOT NULL,signature TEXT,sha256 TEXT NOT NULL) STRICT;`);
      for(const r of this.db.prepare('SELECT * FROM signer_reservations').all())this.parse(r);
    }catch(error){this.db.close();throw error;}
  }
  private parse(r:Record<string,unknown>):{sequence:bigint;digest:Hex;signature:Hex|null;identity:string}{
    try{
      if(typeof r.ns!=='string'||!r.ns||typeof r.identity!=='string'||typeof r.sequence!=='string'||!(/^[1-9]\d*$/.test(r.sequence))
        ||BigInt(r.sequence)>=(1n<<64n)||r.identity!==`${r.ns}:${r.sequence}`
        ||typeof r.digest!=='string'||!/^0x[\da-fA-F]{64}$/.test(r.digest)
        ||r.signature!==null&&typeof r.signature!=='string'
        ||checksum(`${r.identity}:${r.digest}:${r.signature??''}`)!==r.sha256)throw new Error();
      if(r.signature!==null)canonicalSignature(r.signature as Hex);
      return {sequence:BigInt(r.sequence),digest:r.digest as Hex,signature:r.signature as Hex|null,identity:r.identity};
    }catch{throw new Error('SIGNER_JOURNAL_INTEGRITY');}
  }
  private async verifySignature(identity:string,digest:Hex,signature:Hex):Promise<void>{
    canonicalSignature(signature);const key=checksum(`${identity}:${digest}:${signature}`);
    if(this.verified.has(key))return;
    try{if((await recoverAddress({hash:digest,signature})).toLowerCase()!==this.address.toLowerCase())throw new Error();}
    catch{throw new Error('SIGNER_JOURNAL_SIGNATURE_MISMATCH');}
    if(this.verified.size>=1024)this.verified.delete(this.verified.values().next().value!);
    this.verified.add(key);
  }
  /** Re-read checksums/identities every time; cached cryptographic checks bind exact bytes. */
  async verifyJournal():Promise<void>{
    for(const row of this.db.prepare('SELECT * FROM signer_reservations WHERE ns=?').all(this.namespace)){
      const r=this.parse(row);if(r.signature)await this.verifySignature(r.identity,r.digest,r.signature);
    }
  }
  private tx<T>(fn:()=>T):T {this.db.exec('BEGIN IMMEDIATE');try{const value=fn();this.db.exec('COMMIT');return value;}catch(e){this.db.exec('ROLLBACK');throw e;}}
  reservations():{sequence:bigint;digest:Hex}[] {
    return this.db.prepare('SELECT * FROM signer_reservations WHERE ns=?').all(this.namespace)
      .map(row=>{const r=this.parse(row);return {sequence:r.sequence,digest:r.digest};});
  }
  reconcile(owner:string,fence:bigint,chain:{lastSequence:bigint;lastObservedAt:bigint}):void {
    if(this.chainId===10143n){
      const reservations=new Map(this.db.prepare('SELECT sequence,digest,signature FROM signer_reservations WHERE ns=?').all(this.namespace).map(r=>[String(r.sequence),r]));
      for(const saved of this.store.list(this.domain))if(saved.signature){
        const r=reservations.get(saved.packet.observation.sequence.toString());
        if(!r||r.digest!==saved.digest||r.signature!==saved.signature)throw new Error('SIGNER_JOURNAL_BEHIND_OR_MISMATCH');
      }
    }
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
        const parsed=this.parse(existing);
        if(existing.ns!==this.namespace||parsed.sequence!==sequence||existing.digest!==request.digest)throw new Error('SIGNER_IDENTITY_CONFLICT');
        return existing.signature as Hex|null;
      }
      this.db.prepare('INSERT INTO signer_reservations VALUES(?,?,?,?,NULL,?)').run(request.identity,this.namespace,sequence.toString(),request.digest,checksum(`${request.identity}:${request.digest}:`));
      return null;
    });
    if(cached){
      await this.verifySignature(request.identity,request.digest,cached);
      this.store.assertWriter(this.domain,request.owner,request.fence,this.now());return cached;
    }
    const signature=await this.account.sign({hash:request.digest});
    await this.verifySignature(request.identity,request.digest,signature);
    // A crash after reservation retries the same deterministic raw signature.
    this.store.assertWriter(this.domain,request.owner,request.fence,this.now());
    this.tx(()=>{
      this.db.prepare('UPDATE signer_reservations SET signature=?,sha256=? WHERE identity=? AND digest=?').run(signature,checksum(`${request.identity}:${request.digest}:${signature}`),request.identity,request.digest);
    });
    return signature;
  }
  close():void {this.db.close();}
}
