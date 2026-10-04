import { createHash } from 'node:crypto';
import { recoverAddress, keccak256, stringToHex, type Hex } from 'viem';
import { record } from './book.js';
import { inspectSnapshot, metadataIdentity, verifyEventMembership } from './collector.js';
import type { MarketConfig } from './config.js';
import { json } from './math.js';
import { parseRules, rulesHash, type RulesManifest } from './rules.js';
import { sourceTime } from './time.js';
import { PacketStore, packetNamespace, type PacketDomain, type PreparedPacket, type StoredPacket } from './packet-store.js';
import { observationDigest } from './wire.js';

// Versioned development policy definitions, not approvals of provider semantics.
export const DEVELOPMENT_POLICIES={
  quotePolicyHash:keccak256(stringToHex('UNAPPROVED-DIAGNOSTIC:quoted-outcome-price-no-conversion-v1')),
  quantityPolicyHash:keccak256(stringToHex('UNAPPROVED-DIAGNOSTIC:exact-18-decimal-claims-floor-total-1000-lots-v1')),
  timestampPolicyHash:keccak256(stringToHex('preserve-source-ms-floor-seconds-freeze-published-recheck-30s-v1')),
  failurePolicyHash:keccak256(stringToHex('UNAPPROVED-DIAGNOSTIC:valid-only-no-fabricated-time-v1')),
};
// User-selected local policy. A different failure hash requires a new local listing/domain.
export const DEVELOPMENT_INVALID_POLICIES={...DEVELOPMENT_POLICIES,
  failurePolicyHash:keccak256(stringToHex('UNAPPROVED-DIAGNOSTIC:fresh-invalid-zero-price-impacts-preserve-depth-v1'))};
export function permitsInvalidDepth(rules:RulesManifest):boolean {
  return rules.failurePolicyHash.toLowerCase()===DEVELOPMENT_INVALID_POLICIES.failurePolicyHash;
}
export type SnapshotEvidence={bookBody:string;metadata:unknown;event:unknown;bookReceivedAtMs:bigint;
  metadataReceivedAtMs:bigint;eventReceivedAtMs:bigint};
/** Pure builder for disabled development configurations. No key or network access. */
function prepareOnChain(chainId:31337n|10143n,cfg:MarketConfig,rules:RulesManifest,evidence:SnapshotEvidence,sequence:bigint,
  publishedAtMs:bigint,minimumHeadroomMs:bigint):PreparedPacket {
  const d=cfg.destination,m=parseRules(rules);
  if(cfg.enabled||!d)throw new Error('DEVELOPMENT_BUILDER_REQUIRES_DISABLED_DESTINATION');
  if(BigInt(d.chainId)!==chainId)throw new Error('DEVELOPMENT_CHAIN_ONLY');
  if(minimumHeadroomMs<=0n||minimumHeadroomMs>30000n)throw new Error('BAD_PUBLICATION_HEADROOM');
  for(const [field,value] of Object.entries(DEVELOPMENT_POLICIES))
    if(m[field as keyof typeof DEVELOPMENT_POLICIES].toLowerCase()!==value
      &&!(field==='failurePolicyHash'&&permitsInvalidDepth(m)))throw new Error('UNSUPPORTED_RULES_POLICY');
  const bindings={marketId:d.marketId,sourceId:d.sourceId,scheduledT:d.scheduledT,
    ...cfg.mapping,depthNLots:cfg.pricing.depthNLots,maxSpreadWad:cfg.pricing.maxSpreadWad};
  for(const [field,value] of Object.entries(bindings))
    if(String(m[field as keyof RulesManifest]).toLowerCase()!==value.toLowerCase())throw new Error('RULES_CONFIG_MISMATCH');
  if(cfg.pricing.impactMethod!=='vwap'||rulesHash(m)!==d.sourceRulesHash.toLowerCase())throw new Error('RULES_CONFIG_MISMATCH');
  const market=metadataIdentity(cfg,evidence.metadata),event=verifyEventMembership(cfg,evidence.event);
  const externalDigest=createHash('sha256').update(`${event.rulesDigest}:${market.rulesDigest}`).digest('hex');
  if('0x'+externalDigest!==m.externalRulesDigest.toLowerCase())throw new Error('SOURCE_RULES_CHANGED');
  for(const at of [evidence.bookReceivedAtMs,evidence.metadataReceivedAtMs,evidence.eventReceivedAtMs])
    if(at<0n||at>publishedAtMs)throw new Error('BAD_EVIDENCE_TIME');
  const raw=record(JSON.parse(evidence.bookBody));
  const metadataAt=evidence.metadataReceivedAtMs<evidence.eventReceivedAtMs?evidence.metadataReceivedAtMs:evidence.eventReceivedAtMs;
  const inspection=inspectSnapshot(cfg,raw,publishedAtMs,null,{rulesDigest:externalDigest,tradeable:market.tradeable&&event.tradeable},metadataAt,externalDigest);
  const invalid=inspection.status==='INVALID_DEPTH'&&permitsInvalidDepth(m);
  if((inspection.status!=='COLLECTING'&&!invalid)||!inspection.summary||!inspection.time)throw new Error(`OBSERVATION_UNAVAILABLE:${inspection.reason}`);
  if(!sourceTime(raw.timestamp,publishedAtMs,null,minimumHeadroomMs).hasHeadroom)throw new Error('INSUFFICIENT_PUBLICATION_HEADROOM');
  const summary=inspection.summary;
  const observation={marketId:d.marketId,sourceId:d.sourceId,sequence,observedAt:inspection.time.observedAt,
    publishedAt:publishedAtMs/1000n,priceWad:invalid?0n:summary.priceWad!,
    impactBidWad:invalid?0n:summary.impactBidWad!,impactAskWad:invalid?0n:summary.impactAskWad!,
    bidDepthLots:summary.bidDepthLots,askDepthLots:summary.askDepthLots,sourceRulesHash:d.sourceRulesHash};
  const domain:PacketDomain={chainId:BigInt(d.chainId),engine:d.engineAddress,marketId:d.marketId,sourceId:d.sourceId,rulesHash:d.sourceRulesHash,signer:d.signerAddress};
  observationDigest(observation,domain.chainId,domain.engine);
  return {domain,observation,sourceMs:inspection.time.sourceMs,
    evidenceHash:'0x'+createHash('sha256').update(json(evidence)).digest('hex')};
}

export type SignRequest={identity:string;digest:Hex;owner:string;fence:bigint};
/** Backend contract: durable identity->digest uniqueness, idempotent retry, writer fencing.
 * Implementing this interface alone does not certify a production backend. */
export type RawSigner={address:string;signDigest(request:SignRequest):Promise<Hex>};
const SECP_N=0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
function canonicalSignature(signature:Hex):void {
  if(!/^0x[0-9a-fA-F]{130}$/.test(signature))throw new Error('BAD_SIGNATURE_FORMAT');
  const r=BigInt('0x'+signature.slice(2,66)),s=BigInt('0x'+signature.slice(66,130)),v=signature.slice(130).toLowerCase();
  if(r<=0n||r>=SECP_N||s<=0n||s>SECP_N/2n||!['1b','1c'].includes(v))throw new Error('NONCANONICAL_SIGNATURE');
}
const busy=new WeakMap<PacketStore,Set<string>>();
function hasHeadroom(packet:PreparedPacket,now:bigint,minimum:bigint):boolean {
  return now/1000n>=packet.observation.publishedAt&&sourceTime(packet.sourceMs.toString(),now,null,minimum).hasHeadroom;
}
/** Explicit local development signing entry point. Production admission is unchanged. */
async function signOnChain(chainId:31337n|10143n,store:PacketStore,domain:PacketDomain,owner:string,fence:bigint,sequence:bigint,
  signer:RawSigner,now:()=>bigint,minimumHeadroomMs:bigint):Promise<StoredPacket> {
  if(domain.chainId!==chainId)throw new Error('DEVELOPMENT_CHAIN_ONLY');
  if(signer.address.toLowerCase()!==domain.signer.toLowerCase())throw new Error('SIGNER_IDENTITY_MISMATCH');
  if(minimumHeadroomMs<=0n||minimumHeadroomMs>30000n)throw new Error('BAD_SIGNING_HEADROOM');
  const identity=`${packetNamespace(domain)}:${sequence}`,active=busy.get(store)??new Set<string>();busy.set(store,active);
  if(active.has(identity))throw new Error('SIGNING_BUSY');active.add(identity);
  try{
    const stored=store.beginSign(domain,owner,fence,now(),sequence);
    if(!hasHeadroom(stored.packet,now(),minimumHeadroomMs)){
      store.expire(domain,owner,fence,now(),sequence,'PRE_SIGN_HEADROOM_EXPIRED');return store.get(domain,sequence)!;
    }
    if(stored.signature)return stored;
    // Freeze primitive digest/identity before awaiting an external backend.
    const signature=await signer.signDigest({identity,digest:stored.digest,owner,fence});
    canonicalSignature(signature);
    if((await recoverAddress({hash:stored.digest,signature})).toLowerCase()!==domain.signer.toLowerCase())throw new Error('SIGNATURE_RECOVERY_MISMATCH');
    return store.saveSignature(domain,owner,fence,now(),sequence,signature,!hasHeadroom(stored.packet,now(),minimumHeadroomMs));
  }finally{active.delete(identity);}
}

export function prepareObservation(...args:Parameters<typeof prepareOnChain> extends [unknown,...infer A]?A:never):PreparedPacket {
  return prepareOnChain(31337n,...args);
}
export function prepareMonadTestnetObservation(...args:Parameters<typeof prepareObservation>):PreparedPacket {
  return prepareOnChain(10143n,...args);
}
export function signPrepared(...args:Parameters<typeof signOnChain> extends [unknown,...infer A]?A:never):Promise<StoredPacket> {
  return signOnChain(31337n,...args);
}
export function signMonadTestnetPrepared(...args:Parameters<typeof signPrepared>):Promise<StoredPacket> {
  return signOnChain(10143n,...args);
}
