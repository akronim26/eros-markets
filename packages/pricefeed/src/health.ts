import { record } from './book.js';

export function healthView(payload:Record<string,unknown>,nowMs:bigint) {
  if(payload.recordType==='LIFECYCLE'){
    const checkpoint=payload.checkpoint?record(payload.checkpoint):null;
    const blockTime=checkpoint&&typeof checkpoint.blockTimestamp==='string'?BigInt(checkpoint.blockTimestamp)*1000n:null;
    const maxAge=typeof payload.maxCheckpointAgeMs==='string'?BigInt(payload.maxCheckpointAgeMs):null;
    const fresh=checkpoint?.canonical===true&&blockTime!==null&&maxAge!==null&&nowMs>=blockTime&&nowMs-blockTime<=maxAge;
    const active=payload.mode==='COLLECTING'||payload.mode==='RECORD_ONLY';
    return {recordType:'LIFECYCLE',worker:payload.worker??null,category:payload.category??null,lastCaptureAtMs:payload.atMs??null,
      currentStatus:active&&!fresh?'DEGRADED':payload.mode,
      currentReason:active&&!fresh?'LIFECYCLE_CHECKPOINT_STALE_AT_QUERY':payload.reason,
      blockNumber:checkpoint?.blockNumber??null,blockHash:checkpoint?.blockHash??null,blockTimestamp:checkpoint?.blockTimestamp??null,
      checkpointAgeMs:blockTime!==null?nowMs-blockTime:null,freshAtQuery:fresh,operationalOutput:false};
  }
  const inspection=record(payload.inspection);
  const time=inspection.time?record(inspection.time):null;
  const observed=time&&typeof time.observedAt==='string'?BigInt(time.observedAt):null;
  const sourceMs=time&&typeof time.sourceMs==='string'?BigInt(time.sourceMs):null;
  const fresh=observed!==null&&sourceMs!==null&&nowMs>=sourceMs&&nowMs/1000n-observed<=30n;
  return {worker:payload.worker??null,category:payload.category??null,lastCaptureAtMs:payload.atMs??null,
    currentStatus:inspection.status==='COLLECTING'&&!fresh?'DEGRADED':inspection.status,
    currentReason:inspection.status==='COLLECTING'&&!fresh?'LAST_SAMPLE_STALE':inspection.reason,
    observedAt:observed,currentSourceAgeMs:sourceMs!==null?nowMs-sourceMs:null,
    freshAtQuery:fresh,operationalOutput:false};
}
