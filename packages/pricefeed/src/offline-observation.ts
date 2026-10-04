import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import { record } from './book.js';
import { inspectSnapshot, metadataIdentity, verifyEventMembership } from './collector.js';
import type { MarketConfig } from './config.js';
import { uint } from './math.js';
import { prepareObservation, type SnapshotEvidence } from './publication.js';
import type { RulesManifest } from './rules.js';
import { observationDigest } from './wire.js';
import { workerNamespace } from './worker.js';

const sha=(body:string)=>createHash('sha256').update(body).digest('hex');
function parseJson(body:string):unknown {
  try{return JSON.parse(body) as unknown;}catch{throw new Error('INVALID_JSON_INPUT');}
}
function capture(value:unknown):{data:unknown;body:string;at:bigint} {
  const raw=record(value);
  if(typeof raw.body!=='string')throw new Error('MISSING_RAW_CAPTURE_BODY');
  const data=parseJson(raw.body);
  if(!isDeepStrictEqual(data,raw.data))throw new Error('CAPTURE_BODY_DATA_MISMATCH');
  return {data,body:raw.body,at:uint(raw.receivedAtMs,64)};
}

/** Offline historical replay only. Never opens a writer, allocates a sequence or calls a signer/RPC. */
export function buildArchivedObservation(cfg:MarketConfig,rules:RulesManifest,path:string,captureId:string,
  sequence:string,publishedAtMs:string) {
  if(cfg.enabled||!cfg.destination)throw new Error('DEVELOPMENT_BUILDER_REQUIRES_DISABLED_DESTINATION');
  if(cfg.destination.chainId!=='31337')throw new Error('DEVELOPMENT_CHAIN_ONLY');
  const id=uint(captureId,64),seq=uint(sequence,64),published=uint(publishedAtMs,64);
  if(id===0n||id>9223372036854775807n)throw new Error('BAD_CAPTURE_ID');
  if(seq===0n)throw new Error('BAD_SEQUENCE');
  if(cfg.poll.minimumHeadroomMs===0)throw new Error('BAD_PUBLICATION_HEADROOM');
  // readOnly rejects missing files rather than silently creating an empty archive.
  const db=new DatabaseSync(path,{readOnly:true,timeout:1000});
  try{
    db.exec('BEGIN');
    // Stream checksum verification in the same read transaction as selection.
    for(const row of db.prepare('SELECT payload,sha256 FROM captures').iterate())
      if(typeof row.payload!=='string'||sha(row.payload)!==row.sha256)throw new Error('EVIDENCE_INTEGRITY_FAILURE');
    const query=db.prepare('SELECT worker,at_ms,payload,sha256 FROM captures WHERE id=?');query.setReadBigInts(true);
    const row=query.get(id);if(!row)throw new Error('CAPTURE_NOT_FOUND');
    if(row.worker!==workerNamespace(cfg)&&row.worker!==workerNamespace({...cfg,destination:null}))throw new Error('CAPTURE_WORKER_MISMATCH');
    const payload=record(parseJson(String(row.payload)));
    if(payload.worker!==cfg.key||payload.category!==cfg.category)throw new Error('CAPTURE_WORKER_MISMATCH');
    const at=uint(row.at_ms,64);
    const collectedAt=uint(payload.atMs,64);
    if(collectedAt>at||published<at)throw new Error('BAD_EVIDENCE_TIME');
    const provenance={captureId:id,namespace:String(row.worker),atMs:at,payloadSha256:String(row.sha256),
      collectionConfigDigest:typeof payload.configDigest==='string'?payload.configDigest:null};
    const common={mode:'DEVELOPMENT_OFFLINE_REPLAY',operationalOutput:false,signaturesProduced:0,transactionsSent:0,
      sequenceAllocated:false,listingVerified:false,lifecycleVerified:false,readyForSigning:false,
      proposedSequence:seq,replayPublishedAtMs:published,pins:cfg.destination,evidence:provenance};
    const archived=record(payload.inspection);
    if(!['COLLECTING','INVALID_DEPTH'].includes(String(archived.status)))
      return {...common,available:false,reason:'ARCHIVED_CAPTURE_NOT_ELIGIBLE',inspection:null,packet:null,digest:null};
    const book=capture(payload.book),metadata=capture(payload.metadata),event=capture(payload.event);
    if([book.at,metadata.at,event.at].some(time=>time>collectedAt))throw new Error('BAD_EVIDENCE_TIME');
    const evidence:SnapshotEvidence={bookBody:book.body,metadata:metadata.data,event:event.data,
      bookReceivedAtMs:book.at,metadataReceivedAtMs:metadata.at,eventReceivedAtMs:event.at};
    const marketIdentity=metadataIdentity(cfg,metadata.data),eventIdentity=verifyEventMembership(cfg,event.data);
    const externalDigest=sha(`${eventIdentity.rulesDigest}:${marketIdentity.rulesDigest}`);
    const inspection=inspectSnapshot(cfg,record(parseJson(book.body)),published,null,
      {rulesDigest:externalDigest,tradeable:marketIdentity.tradeable&&eventIdentity.tradeable},
      metadata.at<event.at?metadata.at:event.at,externalDigest);
    try{
      const packet=prepareObservation(cfg,rules,evidence,seq,published,BigInt(cfg.poll.minimumHeadroomMs));
      return {...common,available:true,reason:inspection.reason,inspection,packet,
        digest:observationDigest(packet.observation,packet.domain.chainId,packet.domain.engine)};
    }catch(error){
      // Trust/domain errors are command failures, not source-unavailable results.
      if(error instanceof Error&&error.message.startsWith('OBSERVATION_UNAVAILABLE:'))
        return {...common,available:false,reason:inspection.reason,inspection,packet:null,digest:null};
      throw error;
    }
  }finally{db.close();}
}
