import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { json } from './math.js';

export class Journal {
  private readonly db:DatabaseSync;
  constructor(path:string,readOnly=false) {
    this.db=new DatabaseSync(path,{timeout:1000,readOnly});
    if(!readOnly)this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS writers (worker TEXT PRIMARY KEY, owner TEXT NOT NULL, fence INTEGER NOT NULL, until_ms TEXT NOT NULL) STRICT;
      CREATE TABLE IF NOT EXISTS captures (id INTEGER PRIMARY KEY,worker TEXT NOT NULL,at_ms TEXT NOT NULL,payload TEXT NOT NULL,sha256 TEXT NOT NULL) STRICT;`);
  }
  private tx<T>(fn:()=>T):T {this.db.exec('BEGIN IMMEDIATE');try{const result=fn();this.db.exec('COMMIT');return result;}catch(e){this.db.exec('ROLLBACK');throw e;}}
  acquire(worker:string,owner:string,nowMs:bigint,ttlMs:bigint):bigint {
    if(!worker||!owner||nowMs<0n||ttlMs<=0n)throw new Error('BAD_WRITER_LEASE');
    return this.tx(()=>{
      const query=this.db.prepare('SELECT * FROM writers WHERE worker=?');query.setReadBigInts(true);
      const row=query.get(worker);
      if(row&&BigInt(String(row.until_ms))>nowMs&&row.owner!==owner)throw new Error('WRITER_BUSY');
      const fence=row&&row.owner===owner&&BigInt(String(row.until_ms))>nowMs?BigInt(String(row.fence)):BigInt(String(row?.fence??0))+1n;
      this.db.prepare('INSERT INTO writers VALUES (?,?,?,?) ON CONFLICT(worker) DO UPDATE SET owner=excluded.owner,fence=excluded.fence,until_ms=excluded.until_ms').run(worker,owner,fence,(nowMs+ttlMs).toString());
      return fence;
    });
  }
  /** Graceful handoff only. Keep the fence counter; stale owners cannot release successors. */
  release(worker:string,owner:string,fence:bigint):boolean {
    if(!worker||!owner||fence<=0n)throw new Error('BAD_WRITER_LEASE');
    return this.tx(()=>BigInt(this.db.prepare('UPDATE writers SET until_ms=? WHERE worker=? AND owner=? AND fence=?')
      .run('0',worker,owner,fence).changes)===1n);
  }
  append(worker:string,owner:string,fence:bigint,nowMs:bigint,payload:unknown):void {
    this.tx(()=>{
      const query=this.db.prepare('SELECT * FROM writers WHERE worker=?');query.setReadBigInts(true);
      const row=query.get(worker);
      if(!row||row.owner!==owner||BigInt(String(row.fence))!==fence||BigInt(String(row.until_ms))<=nowMs)throw new Error('WRITER_FENCED');
      const body=json(payload),hash=createHash('sha256').update(body).digest('hex');
      this.db.prepare('INSERT INTO captures(worker,at_ms,payload,sha256) VALUES (?,?,?,?)').run(worker,nowMs.toString(),body,hash);
    });
  }
  read(worker:string):{atMs:bigint;payload:Record<string,unknown>}[] {
    return this.db.prepare('SELECT at_ms,payload FROM captures WHERE worker=? ORDER BY id').all(worker)
      .map(row=>({atMs:BigInt(String(row.at_ms)),payload:JSON.parse(String(row.payload)) as Record<string,unknown>}));
  }
  latest(worker:string):{atMs:bigint;payload:Record<string,unknown>}|null {
    const row=this.db.prepare('SELECT at_ms,payload FROM captures WHERE worker=? ORDER BY id DESC LIMIT 1').get(worker);
    return row?{atMs:BigInt(String(row.at_ms)),payload:JSON.parse(String(row.payload)) as Record<string,unknown>}:null;
  }
  workers():string[] {return this.db.prepare('SELECT DISTINCT worker FROM captures ORDER BY worker').all().map(row=>String(row.worker));}
  /** Streams rows: the archive grows by one capture per poll, so loading it whole runs out of memory. */
  verify():boolean {
    for(const row of this.db.prepare('SELECT payload,sha256 FROM captures').iterate())
      if(createHash('sha256').update(String(row.payload)).digest('hex')!==row.sha256)return false;
    return true;
  }
  close():void {this.db.close();}
}

/**
 * Delete captures older than `keepMs`, always keeping the newest row of every worker (the only
 * row the running services read). Batched so each write lock stays short beside the live writer.
 * Signed observations live in packets.sqlite and on-chain; old raw captures are only an audit
 * trail. Freed pages are reused, so the file stops growing; reclaim existing space with VACUUM
 * while the publisher is stopped.
 */
export function pruneCaptures(path:string,{keepMs,nowMs,batch=500,maxTxMs=50,pauseMs=25}:{keepMs:bigint;nowMs:bigint;batch?:number;maxTxMs?:number;pauseMs?:number}):{deleted:number;kept:number} {
  if(keepMs<60_000n||nowMs<=keepMs||!Number.isInteger(batch)||batch<1||batch>10_000
    ||!(maxTxMs>=1&&maxTxMs<=500)||!(pauseMs>=0&&pauseMs<=1000))throw new Error('BAD_RETENTION_POLICY');
  // The live writer waits at most 1 s for a lock: keep each transaction short and yield between them.
  const pause=new Int32Array(new SharedArrayBuffer(4));
  const db=new DatabaseSync(path,{timeout:5000});
  try{
    const cutoff=nowMs-keepMs;
    const keep=new Set(db.prepare('SELECT max(id) AS id FROM captures GROUP BY worker').all().map(row=>Number(row.id)));
    const select=db.prepare('SELECT id FROM captures WHERE CAST(at_ms AS INTEGER) < ? ORDER BY id LIMIT ?');
    const remove=db.prepare('DELETE FROM captures WHERE id=?');
    let deleted=0;
    for(;;){
      db.exec('BEGIN IMMEDIATE');
      let removed=0,seen=0;const started=Date.now();
      try{
        for(const row of select.all(cutoff.toString(),batch+keep.size)){
          // Progress first: the time budget applies only after this transaction removed a row.
          if(seen>=batch||(removed>0&&Date.now()-started>=maxTxMs))break;
          seen++;
          if(keep.has(Number(row.id)))continue;
          remove.run(Number(row.id));removed++;
        }
        db.exec('COMMIT');
      }catch(error){db.exec('ROLLBACK');throw error;}
      deleted+=removed;
      if(removed===0)break;
      if(pauseMs)Atomics.wait(pause,0,0,pauseMs);
    }
    const kept=Number(db.prepare('SELECT count(*) AS n FROM captures').get()!.n);
    return {deleted,kept};
  }finally{db.close();}
}
