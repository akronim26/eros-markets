import { record } from './book.js';

export function healthView(payload:Record<string,unknown>,nowMs:bigint) {
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
