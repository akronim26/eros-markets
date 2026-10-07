/** Wait for the exact sample acknowledgement without coupling INDEX uptime to the keeper. */
export async function awaitSampleAck({ id, engine, readAck, readStatus, signal, now = Date.now,
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), timeoutMs = 20_000 }) {
  const deadline = now() + timeoutMs;
  while (!signal.aborted && now() < deadline) {
    const ack = readAck();
    if (ack?.id === id && ack.engine?.toLowerCase() === engine.toLowerCase()) {
      if (ack.sampledAt !== null && !/^\d+$/.test(ack.sampledAt)) throw Error('INVALID_SAMPLER_TIMESTAMP');
      return { outcome: ack.outcome, acknowledged: true, sampledAt: ack.sampledAt === null ? null : BigInt(ack.sampledAt),
        ...(ack.captureVersion === 1 ? { capture: captureFromAck(ack) } : {}) };
    }
    const status = readStatus();
    if (status) {
      if (status.engine?.toLowerCase() !== engine.toLowerCase()) throw Error('SAMPLER_IDENTITY_MISMATCH');
      if (!Number.isSafeInteger(status.at) || status.at > now() + 5000) throw Error('INVALID_SAMPLER_HEARTBEAT');
      if (status.state === 'stopped' || now() - status.at > 8000) return { outcome: 'sampler-unavailable', acknowledged: false };
    }
    await sleep(250);
  }
  return { outcome: signal.aborted ? 'stopped' : 'coordination-timeout', acknowledged: false };
}

const decimal = value => typeof value === 'string' && /^(0|[1-9]\d*)$/.test(value);
function checkIdentity(value, engine) {
  if (!value || !decimal(value.id) || value.engine?.toLowerCase() !== engine.toLowerCase()) throw Error('SAMPLER_IDENTITY_MISMATCH');
}
/** Only versioned event evidence represents a capture; legacy receipt times do not. */
export function captureFromAck(ack) {
  if (ack.captureVersion !== 1) throw Error('SAMPLER_CAPTURE_VERSION_REQUIRED');
  if (ack.sampledAt === null && ack.sampledBlock === null && ack.sampledBlockHash === null) return null;
  if (!decimal(ack.sampledAt) || !decimal(ack.sampledBlock) || !/^0x[0-9a-fA-F]{64}$/.test(ack.sampledBlockHash)) throw Error('INVALID_SAMPLER_CAPTURE');
  return { observedAt: BigInt(ack.sampledAt), block: BigInt(ack.sampledBlock), blockHash: ack.sampledBlockHash.toLowerCase() };
}

/** INDEX selection has no dependency on sampler progress. Relay freshness still applies. */
export const indexFreshCutoff = nowMs => BigInt(Math.floor(nowMs / 1000)) - 18n;

/** One durable request at a time; INDEX callers only enqueue finalized observations. */
export class SampleCoordinator {
  constructor({ engine, readRequest, readAck, readStatus, writeRequest, signal, onResult = () => {}, onError = () => {},
    now = Date.now, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), timeoutMs = 20_000 }) {
    this.options = { engine, readRequest, readAck, readStatus, writeRequest, onResult, onError, now, sleep, timeoutMs };
    this.stop = new AbortController();
    this.pending = null; this.outstanding = null; this.capture = null; this.lastSequence = 0n; this.latestFinalized = null;
    const ack = readAck(), request = readRequest();
    if (ack) {
      checkIdentity(ack, engine);
      this.lastSequence = BigInt(ack.id);
      if (ack.captureVersion === 1) this.capture = captureFromAck(ack);
    }
    if (request) {
      checkIdentity(request, engine);
      if (!ack || ack.id !== request.id) {
        if (BigInt(request.id) <= this.lastSequence) throw Error('SAMPLER_REQUEST_ORDER_MISMATCH');
        this.outstanding = request;
      }
    }
    this.externalSignal = signal;
    this.forward = () => this.stop.abort();
    signal.addEventListener('abort', this.forward, { once: true });
    if (signal.aborted) this.stop.abort();
    this.task = this.run().catch(error => { this.stop.abort(); onError(error); });
  }
  notify({ sequence, observedAt, depthValid = true }) {
    if (this.stop.signal.aborted) return;
    if (typeof sequence !== 'bigint' || sequence <= 0n || typeof observedAt !== 'bigint' || observedAt < 0n) throw Error('INVALID_FINALIZED_OBSERVATION');
    if (this.latestFinalized && sequence < this.latestFinalized.sequence) return;
    if (this.latestFinalized && sequence === this.latestFinalized.sequence && observedAt !== this.latestFinalized.observedAt) throw Error('FINALIZED_OBSERVATION_CONFLICT');
    if (!this.latestFinalized || sequence > this.latestFinalized.sequence) {
      if (this.latestFinalized && observedAt < this.latestFinalized.observedAt) throw Error('FINALIZED_SOURCE_MOVED_BACKWARDS');
      this.latestFinalized = { sequence, observedAt, depthValid };
    }
    if (!depthValid) return;
    if (sequence <= this.lastSequence || (this.outstanding && sequence <= BigInt(this.outstanding.id))) return;
    if (this.pending && sequence === this.pending.sequence && observedAt !== this.pending.observedAt) throw Error('FINALIZED_OBSERVATION_CONFLICT');
    if (!this.pending || sequence > this.pending.sequence) this.pending = { sequence, observedAt };
  }
  getMinimumObservedAt(nowMs, freshCutoff = indexFreshCutoff(nowMs), deliveryReserveSecs = 8n) {
    const nowSec = BigInt(Math.floor(nowMs / 1000));
    if (deliveryReserveSecs <= 0n || deliveryReserveSecs >= 30n) throw Error('INVALID_DELIVERY_RESERVE');
    // Prefer a sealable prefix only while the previously accepted INDEX still
    // leaves delivery time. This is a scheduling preference, never admission.
    if (this.stop.signal.aborted || !this.latestFinalized?.depthValid || nowSec >= this.latestFinalized.observedAt + 30n - deliveryReserveSecs) return freshCutoff;
    const aboutToCapture = this.pending && (!this.capture || this.pending.observedAt > this.capture.observedAt);
    const preferred = this.outstanding || aboutToCapture ? nowSec : this.capture?.observedAt;
    return preferred !== undefined && preferred > freshCutoff ? preferred : freshCutoff;
  }
  async run() {
    const o = this.options;
    while (!this.stop.signal.aborted) {
      if (!this.outstanding && this.pending && (!this.capture || this.pending.observedAt > this.capture.observedAt)) {
        const observation = this.pending;
        const request = { id: observation.sequence.toString(), engine: o.engine, observedAt: observation.observedAt.toString() };
        o.writeRequest(request); // persist before accepting any newer request
        this.outstanding = request; this.pending = null;
      }
      if (this.outstanding) {
        const request = this.outstanding;
        const result = await awaitSampleAck({ ...o, id: request.id, signal: this.stop.signal });
        if (this.stop.signal.aborted) break;
        if (result.acknowledged) {
          const capture = result.capture;
          if (capture === undefined) throw Error('SAMPLER_CAPTURE_VERSION_REQUIRED');
          if (capture && this.capture && (capture.observedAt < this.capture.observedAt || capture.block < this.capture.block
            || (capture.block === this.capture.block && capture.blockHash !== this.capture.blockHash))) throw Error('SAMPLER_CAPTURE_MOVED_BACKWARDS');
          if (capture) this.capture = capture;
          this.lastSequence = BigInt(request.id); this.outstanding = null;
          if (this.pending && this.pending.sequence <= this.lastSequence) this.pending = null;
        }
        o.onResult({ ...result, sequence: BigInt(request.id) });
        // A timeout/stopped keeper is not evidence that its request cannot execute.
        // Keep ownership and wait for its exact late ack, while INDEX continues.
      }
      if (!this.stop.signal.aborted) await o.sleep(250);
    }
  }
  async close() {
    this.stop.abort();
    await this.task;
    this.externalSignal.removeEventListener('abort', this.forward);
  }
}
