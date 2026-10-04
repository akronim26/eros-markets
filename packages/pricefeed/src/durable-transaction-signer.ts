import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { isAddress, keccak256, parseTransaction, recoverTransactionAddress, type Hex, type TransactionSerialized } from 'viem';
import type { PrivateKeyAccount } from 'viem/accounts';
import { json } from './math.js';

export type RelayTransactionRequest={to:string;data:Hex;nonce:bigint;gas:bigint;maxFeePerGas:bigint;maxPriorityFeePerGas:bigint};
export type TransactionReservation={request:RelayTransactionRequest;raw:Hex|null};
export type TransactionJournal={readonly id:string;reconcile(reservations:readonly TransactionReservation[]):Promise<void>};
const sha=(s:string)=>createHash('sha256').update(s).digest('hex');
export function canonicalTransactionRequest(r:RelayTransactionRequest):RelayTransactionRequest {
  const u256=(n:bigint)=>typeof n==='bigint'&&n>=0n&&n<(1n<<256n);
  if(!r||typeof r.to!=='string'||typeof r.data!=='string'||!isAddress(r.to)||/^0x0{40}$/i.test(r.to)||!/^0x(?:[0-9a-fA-F]{2})+$/.test(r.data)||r.data.length>131074
    ||typeof r.nonce!=='bigint'||r.nonce<0n||r.nonce>BigInt(Number.MAX_SAFE_INTEGER)
    ||!u256(r.gas)||r.gas===0n||!u256(r.maxFeePerGas)||r.maxFeePerGas===0n||!u256(r.maxPriorityFeePerGas)
    ||r.maxPriorityFeePerGas>r.maxFeePerGas)throw new Error('BAD_TRANSACTION_REQUEST');
  return {to:r.to.toLowerCase(),data:r.data.toLowerCase() as Hex,nonce:r.nonce,gas:r.gas,maxFeePerGas:r.maxFeePerGas,maxPriorityFeePerGas:r.maxPriorityFeePerGas};
}
export function parseTransactionRequest(raw:unknown):RelayTransactionRequest {
  const r=raw as Record<string,unknown>;
  if(!r||typeof r.to!=='string'||typeof r.data!=='string'
    ||['nonce','gas','maxFeePerGas','maxPriorityFeePerGas'].some(k=>typeof r[k]!=='string'||!/^(0|[1-9]\d*)$/.test(r[k] as string)))throw new Error('BAD_TRANSACTION_REQUEST');
  return canonicalTransactionRequest({to:r.to,data:r.data as Hex,nonce:BigInt(r.nonce as string),gas:BigInt(r.gas as string),
    maxFeePerGas:BigInt(r.maxFeePerGas as string),maxPriorityFeePerGas:BigInt(r.maxPriorityFeePerGas as string)});
}
/** Independent durable transaction identity; wrappers pin their key and chain.
 * No network I/O or broadcast. Loss/restore is checked against the relay before use. */
export class DurableTransactionSigner implements TransactionJournal {
  private readonly db:DatabaseSync;
  readonly address:string;
  readonly id:string;
  protected constructor(path:string,create:boolean,private readonly account:PrivateKeyAccount,private readonly chainId:31337|10143){
    this.address=account.address;
    if(!existsSync(path)&&!create)throw new Error('TRANSACTION_SIGNER_JOURNAL_MISSING');
    this.db=new DatabaseSync(path,{timeout:1000});
    try{
      this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
        CREATE TABLE IF NOT EXISTS transaction_signer(id TEXT PRIMARY KEY,sender TEXT NOT NULL,chain_id TEXT NOT NULL,schema_version INTEGER NOT NULL) STRICT;
        CREATE TABLE IF NOT EXISTS transaction_reservations(nonce TEXT PRIMARY KEY,request TEXT NOT NULL,raw TEXT,tx_hash TEXT,sha256 TEXT NOT NULL) STRICT;`);
      this.tx(()=>{
        const meta=this.db.prepare('SELECT * FROM transaction_signer').all();
        if(meta.length===0){
          if(!create||this.db.prepare('SELECT count(*) AS n FROM transaction_reservations').get()!.n!==0)throw new Error('TRANSACTION_SIGNER_JOURNAL_INTEGRITY');
          this.db.prepare('INSERT INTO transaction_signer VALUES(?,?,?,1)').run(randomUUID(),this.address.toLowerCase(),String(this.chainId));
        }
      });
      const meta=this.db.prepare('SELECT * FROM transaction_signer').all();
      if(meta.length!==1||meta[0]!.sender!==this.address.toLowerCase()||meta[0]!.chain_id!==String(this.chainId)||meta[0]!.schema_version!==1)throw new Error('TRANSACTION_SIGNER_IDENTITY_MISMATCH');
      this.id=String(meta[0]!.id);
      if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(this.id))throw new Error('TRANSACTION_SIGNER_JOURNAL_INTEGRITY');
      for(const row of this.db.prepare('SELECT * FROM transaction_reservations').all())this.parse(row);
    }catch(error){this.db.close();throw error;}
  }
  private tx<T>(fn:()=>T):T {this.db.exec('BEGIN IMMEDIATE');try{const r=fn();this.db.exec('COMMIT');return r;}catch(error){this.db.exec('ROLLBACK');throw error;}}
  private parse(row:Record<string,unknown>):TransactionReservation {
    try{
      const request=parseTransactionRequest(JSON.parse(String(row.request))),raw=row.raw as Hex|null;
      if(json(request)!==row.request||request.nonce.toString()!==row.nonce||sha(`${row.request}:${raw??''}:${row.tx_hash??''}`)!==row.sha256)throw new Error();
      if(raw===null){if(row.tx_hash!==null)throw new Error();}
      else{
        const t=parseTransaction(raw);
        if(keccak256(raw)!==row.tx_hash||t.type!=='eip1559'||t.chainId!==this.chainId||t.to?.toLowerCase()!==request.to
          ||t.data!==request.data||t.nonce!==Number(request.nonce)||(t.value??0n)!==0n||t.gas!==request.gas
          ||t.maxFeePerGas!==request.maxFeePerGas||t.maxPriorityFeePerGas!==request.maxPriorityFeePerGas)throw new Error();
      }
      return {request,raw};
    }catch{throw new Error('TRANSACTION_SIGNER_JOURNAL_INTEGRITY');}
  }
  private async validateSigner(raw:Hex):Promise<void>{
    if((await recoverTransactionAddress({serializedTransaction:raw as TransactionSerialized})).toLowerCase()!==this.address.toLowerCase())throw new Error('TRANSACTION_SIGNER_JOURNAL_INTEGRITY');
  }
  async reconcile(reservations:readonly TransactionReservation[]):Promise<void>{
    const expected=new Map<string,TransactionReservation>();
    for(const r of reservations){
      const request=canonicalTransactionRequest(r.request),nonce=request.nonce.toString();
      if(expected.has(nonce))throw new Error('TRANSACTION_SIGNER_RELAY_MISMATCH');expected.set(nonce,{request,raw:r.raw});
    }
    const actual=new Map<string,TransactionReservation>();
    for(const row of this.db.prepare('SELECT * FROM transaction_reservations').all()){
      const saved=this.parse(row),nonce=saved.request.nonce.toString(),r=expected.get(nonce);
      if(!r||json(r.request)!==json(saved.request)||(r.raw!==null&&r.raw!==saved.raw))throw new Error('TRANSACTION_SIGNER_AHEAD_OR_MISMATCH');
      if(saved.raw)await this.validateSigner(saved.raw);actual.set(nonce,saved);
    }
    for(const [nonce,r] of expected)if(r.raw!==null&&!actual.get(nonce)?.raw)throw new Error('TRANSACTION_SIGNER_BEHIND_RELAY');
  }
  async sign(input:RelayTransactionRequest):Promise<Hex>{
    const request=canonicalTransactionRequest(input),body=json(request),nonce=request.nonce.toString();
    const cached=this.tx(()=>{
      const row=this.db.prepare('SELECT * FROM transaction_reservations WHERE nonce=?').get(nonce);
      if(row){const saved=this.parse(row);if(json(saved.request)!==body)throw new Error('TRANSACTION_SIGNER_NONCE_CONFLICT');return saved.raw;}
      this.db.prepare('INSERT INTO transaction_reservations VALUES(?,?,NULL,NULL,?)').run(nonce,body,sha(`${body}::`));return null;
    });
    if(cached){await this.validateSigner(cached);return cached;}
    const raw=await this.account.signTransaction({type:'eip1559',chainId:this.chainId,to:request.to as Hex,data:request.data,nonce:Number(request.nonce),
      gas:request.gas,maxFeePerGas:request.maxFeePerGas,maxPriorityFeePerGas:request.maxPriorityFeePerGas,value:0n});
    const hash=keccak256(raw);
    this.tx(()=>{
      const row=this.db.prepare('SELECT * FROM transaction_reservations WHERE nonce=?').get(nonce)!;
      const saved=this.parse(row);if(json(saved.request)!==body||(saved.raw!==null&&saved.raw!==raw))throw new Error('TRANSACTION_SIGNER_NONCE_CONFLICT');
      this.db.prepare('UPDATE transaction_reservations SET raw=?,tx_hash=?,sha256=? WHERE nonce=?').run(raw,hash,sha(`${body}:${raw}:${hash}`),nonce);
    });return raw;
  }
  close():void {this.db.close();}
}
