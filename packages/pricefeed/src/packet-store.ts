import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { isAddress, type Hex } from 'viem';
import { json, UINT64_MAX } from './math.js';
import { observationDigest, parseObservation, type Observation } from './wire.js';

export type PacketDomain={chainId:bigint;engine:string;marketId:string;sourceId:string;rulesHash:string;signer:string};
export type PreparedPacket={domain:PacketDomain;observation:Observation;sourceMs:bigint;evidenceHash:string};
export type PacketState='ALLOCATED'|'SIGNING'|'SIGNED'|'EXPIRED';
export type StoredPacket={packet:PreparedPacket;digest:Hex;signature:Hex|null;state:PacketState;reason:string|null};
const hash=(text:string)=>createHash('sha256').update(text).digest('hex');
export function packetNamespace(d:PacketDomain):string {
  if(d.chainId<=0n||d.chainId>=(1n<<256n)||!isAddress(d.engine)||!isAddress(d.signer)
    ||/^0x0{40}$/i.test(d.engine)||/^0x0{40}$/i.test(d.signer)
    ||[d.marketId,d.sourceId,d.rulesHash].some(v=>!/^0x[0-9a-fA-F]{64}$/.test(v)))throw new Error('BAD_PACKET_DOMAIN');
  return `${d.chainId}:${d.engine.toLowerCase()}:${d.sourceId.toLowerCase()}`;
}
function canonicalDomain(d:PacketDomain):PacketDomain {
  packetNamespace(d);return {...d,engine:d.engine.toLowerCase(),signer:d.signer.toLowerCase(),marketId:d.marketId.toLowerCase(),sourceId:d.sourceId.toLowerCase(),rulesHash:d.rulesHash.toLowerCase()};
}
function parsePacket(body:string):PreparedPacket {
  const raw=JSON.parse(body);
  const p={...raw,domain:{...raw.domain,chainId:BigInt(raw.domain.chainId)},observation:parseObservation(raw.observation),sourceMs:BigInt(raw.sourceMs)} as PreparedPacket;
  validatePacket(p);return p;
}
function validatePacket(p:PreparedPacket):void {
  const d=canonicalDomain(p.domain),o=p.observation;
  observationDigest(o,d.chainId,d.engine);
  if(o.marketId.toLowerCase()!==d.marketId||o.sourceId.toLowerCase()!==d.sourceId||o.sourceRulesHash.toLowerCase()!==d.rulesHash
    ||p.sourceMs<=0n||p.sourceMs/1000n!==o.observedAt||!/^0x[0-9a-f]{64}$/.test(p.evidenceHash))throw new Error('PACKET_BINDING_MISMATCH');
}

/** Durable unsigned/signed packet journal. No wallet or transport is constructed. */
export class PacketStore {
  private readonly db:DatabaseSync;
  private readonly reconciled=new Map<string,string>();
  constructor(path:string){
    this.db=new DatabaseSync(path,{timeout:1000});
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS packet_workers(ns TEXT PRIMARY KEY,domain TEXT NOT NULL,next_seq TEXT NOT NULL,last_ms TEXT NOT NULL,owner TEXT NOT NULL,fence INTEGER NOT NULL,until_ms TEXT NOT NULL) STRICT;
      CREATE TABLE IF NOT EXISTS packets(ns TEXT NOT NULL,sequence TEXT NOT NULL,body TEXT NOT NULL,sha256 TEXT NOT NULL,digest TEXT NOT NULL,signature TEXT,state TEXT NOT NULL,reason TEXT,PRIMARY KEY(ns,sequence)) STRICT;`);
    if(!this.verify()){this.db.close();throw new Error('PACKET_JOURNAL_INTEGRITY');}
  }
  private tx<T>(fn:()=>T):T {this.db.exec('BEGIN IMMEDIATE');try{const r=fn();this.db.exec('COMMIT');return r;}catch(e){this.db.exec('ROLLBACK');throw e;}}
  private worker(ns:string){const q=this.db.prepare('SELECT * FROM packet_workers WHERE ns=?');q.setReadBigInts(true);return q.get(ns);}
  private lease(d:PacketDomain,owner:string,fence:bigint,now:bigint){
    const ns=packetNamespace(d),row=this.worker(ns);
    if(now<0n||!row||row.owner!==owner||BigInt(String(row.fence))!==fence||BigInt(String(row.until_ms))<=now)throw new Error('PACKET_WRITER_FENCED');
    if(row.domain!==json(canonicalDomain(d)))throw new Error('PACKET_DOMAIN_CHANGED');
    return row;
  }
  acquire(d:PacketDomain,owner:string,now:bigint,ttl:bigint):bigint {
    if(!owner||now<0n||ttl<=0n)throw new Error('BAD_PACKET_LEASE');
    return this.tx(()=>{
      const ns=packetNamespace(d),row=this.worker(ns),domain=json(canonicalDomain(d));
      if(row&&row.domain!==domain)throw new Error('PACKET_DOMAIN_CHANGED');
      if(row&&BigInt(String(row.until_ms))>now&&row.owner!==owner)throw new Error('PACKET_WRITER_BUSY');
      const fence=row&&row.owner===owner&&BigInt(String(row.until_ms))>now?BigInt(String(row.fence)):BigInt(String(row?.fence??0))+1n;
      this.db.prepare(`INSERT INTO packet_workers VALUES(?,?,'1','0',?,?,?) ON CONFLICT(ns) DO UPDATE SET owner=excluded.owner,fence=excluded.fence,until_ms=excluded.until_ms`).run(ns,domain,owner,fence,(now+ttl).toString());
      if(!row||row.owner!==owner||BigInt(String(row.fence))!==fence)this.reconciled.delete(ns);
      return fence;
    });
  }
  reconcile(d:PacketDomain,owner:string,fence:bigint,now:bigint,chain:{lastSequence:bigint;lastObservedAt:bigint}):void {
    const ns=packetNamespace(d);this.reconciled.delete(ns);
    this.lease(d,owner,fence,now);
    if(chain.lastSequence<0n||chain.lastSequence>UINT64_MAX||chain.lastObservedAt<0n||chain.lastObservedAt>UINT64_MAX)throw new Error('BAD_CHAIN_STATE');
    if(chain.lastSequence>0n){
      const known=this.get(d,chain.lastSequence);
      if(!known?.signature)throw new Error('UNKNOWN_CHAIN_SEQUENCE');
      if(known.packet.observation.observedAt!==chain.lastObservedAt)throw new Error('CHAIN_TIME_MISMATCH');
    }else if(chain.lastObservedAt!==0n)throw new Error('CHAIN_TIME_MISMATCH');
    this.reconciled.set(ns,`${owner}:${fence}:${chain.lastObservedAt}`);
  }
  allocate(d:PacketDomain,owner:string,fence:bigint,now:bigint,build:(sequence:bigint)=>PreparedPacket):PreparedPacket {
    return this.tx(()=>{
      const ns=packetNamespace(d),row=this.lease(d,owner,fence,now),check=this.reconciled.get(ns);
      if(!check?.startsWith(`${owner}:${fence}:`))throw new Error('RECONCILE_REQUIRED');
      const sequence=BigInt(String(row.next_seq));if(sequence>UINT64_MAX)throw new Error('SEQUENCE_EXHAUSTED');
      const packet=build(sequence);validatePacket(packet);
      if(json(canonicalDomain(packet.domain))!==json(canonicalDomain(d))||packet.observation.sequence!==sequence)throw new Error('PACKET_DOMAIN_CHANGED');
      if(packet.sourceMs<BigInt(String(row.last_ms))||packet.observation.observedAt<BigInt(check.split(':').at(-1)!))throw new Error('BACKWARDS_SOURCE_TIME');
      const body=json(packet),digest=observationDigest(packet.observation,d.chainId,d.engine);
      this.db.prepare('INSERT INTO packets VALUES(?,?,?,?,?,NULL,\'ALLOCATED\',NULL)').run(ns,sequence.toString(),body,hash(body),digest);
      this.db.prepare('UPDATE packet_workers SET next_seq=?,last_ms=? WHERE ns=?').run((sequence+1n).toString(),packet.sourceMs.toString(),ns);
      // Return a parsed copy: caller mutation cannot alter the archived bytes.
      return parsePacket(body);
    });
  }
  get(d:PacketDomain,sequence:bigint):StoredPacket|null {
    const row=this.db.prepare('SELECT * FROM packets WHERE ns=? AND sequence=?').get(packetNamespace(d),sequence.toString());
    if(!row)return null;
    if(hash(String(row.body))!==row.sha256)throw new Error('PACKET_JOURNAL_INTEGRITY');
    const packet=parsePacket(String(row.body)),digest=observationDigest(packet.observation,d.chainId,d.engine);
    if(json(canonicalDomain(packet.domain))!==json(canonicalDomain(d))||digest!==row.digest||packet.observation.sequence!==sequence)throw new Error('PACKET_JOURNAL_INTEGRITY');
    return {packet,digest,signature:row.signature as Hex|null,state:row.state as PacketState,reason:row.reason as string|null};
  }
  beginSign(d:PacketDomain,owner:string,fence:bigint,now:bigint,seq:bigint):StoredPacket {
    return this.tx(()=>{
      this.lease(d,owner,fence,now);
      if(!this.reconciled.get(packetNamespace(d))?.startsWith(`${owner}:${fence}:`))throw new Error('RECONCILE_REQUIRED');
      const stored=this.get(d,seq);if(!stored||stored.state==='EXPIRED')throw new Error('PACKET_NOT_SIGNABLE');
      if(stored.state==='ALLOCATED')this.db.prepare("UPDATE packets SET state='SIGNING' WHERE ns=? AND sequence=?").run(packetNamespace(d),seq.toString());
      return this.get(d,seq)!;
    });
  }
  saveSignature(d:PacketDomain,owner:string,fence:bigint,now:bigint,seq:bigint,signature:Hex,expired:boolean):StoredPacket {
    return this.tx(()=>{
      this.lease(d,owner,fence,now);const stored=this.get(d,seq);
      if(!stored||stored.state!=='SIGNING'||!/^0x[0-9a-fA-F]{130}$/.test(signature))throw new Error('BAD_SIGNATURE_STATE');
      this.db.prepare('UPDATE packets SET signature=?,state=?,reason=? WHERE ns=? AND sequence=?').run(signature,expired?'EXPIRED':'SIGNED',expired?'SIGNING_HEADROOM_EXPIRED':null,packetNamespace(d),seq.toString());
      return this.get(d,seq)!;
    });
  }
  expire(d:PacketDomain,owner:string,fence:bigint,now:bigint,seq:bigint,reason:string):void {
    this.tx(()=>{
      this.lease(d,owner,fence,now);if(!this.get(d,seq)||!reason)throw new Error('BAD_EXPIRY');
      this.db.prepare("UPDATE packets SET state='EXPIRED',reason=? WHERE ns=? AND sequence=?").run(reason,packetNamespace(d),seq.toString());
    });
  }
  verify():boolean {
    try{
      for(const row of this.db.prepare('SELECT * FROM packets').all()){
        if(hash(String(row.body))!==row.sha256)return false;
        const p=parsePacket(String(row.body));
        if(packetNamespace(p.domain)!==row.ns||p.observation.sequence.toString()!==row.sequence
          ||observationDigest(p.observation,p.domain.chainId,p.domain.engine)!==row.digest)return false;
        if(!['ALLOCATED','SIGNING','SIGNED','EXPIRED'].includes(String(row.state)))return false;
        if(row.signature!==null&&!/^0x[0-9a-fA-F]{130}$/.test(String(row.signature)))return false;
        if(row.state==='SIGNED'&&row.signature===null)return false;
      }
      for(const row of this.db.prepare('SELECT * FROM packet_workers').all()){
        const raw=JSON.parse(String(row.domain)),d={...raw,chainId:BigInt(raw.chainId)} as PacketDomain;
        if(packetNamespace(d)!==row.ns)return false;
        const rows=this.db.prepare('SELECT sequence,body FROM packets WHERE ns=?').all(String(row.ns));
        let high=0n,last=0n;
        for(const p of rows){const seq=BigInt(String(p.sequence));if(seq>high)high=seq;const ms=parsePacket(String(p.body)).sourceMs;if(ms>last)last=ms;}
        if(BigInt(String(row.next_seq))!==high+1n||BigInt(String(row.last_ms))!==last)return false;
      }
      return true;
    }catch{return false;}
  }
  close():void {this.db.close();}
}
