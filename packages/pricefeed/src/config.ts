import { isAddress } from 'viem';
import { record, type ImpactMethod } from './book.js';
import { uint, WAD } from './math.js';

export type Category = 'sports' | 'politics' | 'crypto';
export type Destination = {
  chainId:string; engineAddress:string; engineCodeHash:string; abiHash:string; marketId:string;
  sourceId:string; sourceRulesHash:string; signerAddress:string; listedAt:string; scheduledT:string;
  invalidRule:{captureGraceSecs:string;voidSecs:string;fallbackListed:boolean;fallbackPriceWad:string};
};
export type MarketConfig = {
  schemaVersion:'1'; configVersion:string; key:string; category:Category; enabled:boolean;
  destination:Destination|null;
  mapping:{eventId:string;externalMarketId:string;conditionId:string;outcomeTokenId:string;outcomeLabel:string};
  pricing:{depthNLots:string;maxSpreadWad:string;impactMethod:ImpactMethod};
  policies:{timestampPolicyId:string;quantityPolicyId:string;quotePolicyId:string;
    mappingApprovalId:string|null;pricingApprovalId:string|null;timeApprovalId:string|null;rulesApprovalId:string|null;unitsApprovalId:string|null;invalidApprovalId:string|null;operatingApprovalId:string|null};
  requiredFeedUntil:string|null;
  poll:{intervalMs:number;timeoutMs:number;maxRetries:number;retryDelayMs:number;metadataMaxAgeMs:number;
    minimumHeadroomMs:number;bodyLimitBytes:number};
};

function text(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 500) throw new Error(`MISSING_${name}`);
  return value;
}
function hex32(value: unknown): string {
  const v = text(value,'BYTES32'); if (!/^0x[0-9a-fA-F]{64}$/.test(v)) throw new Error('BAD_BYTES32'); return v;
}
function address(value: unknown): string {
  const v = text(value,'ADDRESS'); if (!isAddress(v) || /^0x0{40}$/i.test(v)) throw new Error('BAD_ADDRESS'); return v;
}
function integerString(value: unknown, bits:64|256):string { uint(value,bits); return value as string; }
function bounded(value:unknown,min:number,max:number):number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) throw new Error('BAD_OPERATING_INTEGER');
  return value;
}

export function parseConfig(value:unknown):MarketConfig {
  const raw=record(value), mapping=record(raw.mapping), pricing=record(raw.pricing), policies=record(raw.policies), poll=record(raw.poll);
  if (raw.schemaVersion !== '1' || typeof raw.enabled !== 'boolean') throw new Error('BAD_CONFIG_VERSION_OR_ENABLED');
  if (!['sports','politics','crypto'].includes(String(raw.category))) throw new Error('BAD_CATEGORY');
  if (!['vwap','marginal'].includes(String(pricing.impactMethod))) throw new Error('EXPLICIT_IMPACT_METHOD_REQUIRED');
  const depthNLots=integerString(pricing.depthNLots,256), maxSpreadWad=integerString(pricing.maxSpreadWad,256);
  if (BigInt(depthNLots) === 0n || BigInt(maxSpreadWad) > WAD) throw new Error('BAD_DEPTH_RULE');
  let destination:Destination|null=null;
  if (raw.destination !== null) {
    const d=record(raw.destination), ir=record(d.invalidRule);
    if (typeof ir.fallbackListed !== 'boolean') throw new Error('BAD_INVALID_RULE');
    destination={chainId:integerString(d.chainId,256),engineAddress:address(d.engineAddress),engineCodeHash:hex32(d.engineCodeHash),abiHash:hex32(d.abiHash),marketId:hex32(d.marketId),sourceId:hex32(d.sourceId),sourceRulesHash:hex32(d.sourceRulesHash),signerAddress:address(d.signerAddress),listedAt:integerString(d.listedAt,64),scheduledT:integerString(d.scheduledT,64),invalidRule:{captureGraceSecs:integerString(ir.captureGraceSecs,64),voidSecs:integerString(ir.voidSecs,64),fallbackListed:ir.fallbackListed,fallbackPriceWad:integerString(ir.fallbackPriceWad,256)}};
    if (BigInt(destination.chainId) === 0n || BigInt(destination.invalidRule.fallbackPriceWad)>WAD) throw new Error('BAD_DESTINATION');
  }
  const approval=(key:string) => policies[key] === null ? null : text(policies[key],key);
  const cfg:MarketConfig={schemaVersion:'1',configVersion:text(raw.configVersion,'CONFIG_VERSION'),key:text(raw.key,'KEY'),category:raw.category as Category,enabled:raw.enabled,destination,
    mapping:{eventId:integerString(mapping.eventId,256),externalMarketId:integerString(mapping.externalMarketId,256),conditionId:hex32(mapping.conditionId),outcomeTokenId:integerString(mapping.outcomeTokenId,256),outcomeLabel:text(mapping.outcomeLabel,'OUTCOME_LABEL')},
    pricing:{depthNLots,maxSpreadWad,impactMethod:pricing.impactMethod as ImpactMethod},
    policies:{timestampPolicyId:text(policies.timestampPolicyId,'TIME_POLICY'),quantityPolicyId:text(policies.quantityPolicyId,'QUANTITY_POLICY'),quotePolicyId:text(policies.quotePolicyId,'QUOTE_POLICY'),mappingApprovalId:approval('mappingApprovalId'),pricingApprovalId:approval('pricingApprovalId'),timeApprovalId:approval('timeApprovalId'),rulesApprovalId:approval('rulesApprovalId'),unitsApprovalId:approval('unitsApprovalId'),invalidApprovalId:approval('invalidApprovalId'),operatingApprovalId:approval('operatingApprovalId')},
    requiredFeedUntil:raw.requiredFeedUntil === null ? null : integerString(raw.requiredFeedUntil,64),
    poll:{intervalMs:bounded(poll.intervalMs,1,60000),timeoutMs:bounded(poll.timeoutMs,1,30000),maxRetries:bounded(poll.maxRetries,0,3),retryDelayMs:bounded(poll.retryDelayMs,0,5000),metadataMaxAgeMs:bounded(poll.metadataMaxAgeMs,1,300000),minimumHeadroomMs:bounded(poll.minimumHeadroomMs,0,30000),bodyLimitBytes:bounded(poll.bodyLimitBytes,100,2000000)}};
  if (!/^[a-zA-Z0-9_-]{1,80}$/.test(cfg.key)) throw new Error('BAD_WORKER_KEY');
  if (cfg.enabled) validateOperationalAdmission(cfg,0n);
  return cfg;
}

export function validateOperationalAdmission(cfg:MarketConfig,nowSeconds:bigint):void {
  if (!cfg.enabled) throw new Error('MARKET_DISABLED');
  if (!cfg.destination || cfg.requiredFeedUntil===null) throw new Error('MISSING_DESTINATION_OR_RECORDING_END');
  for (const [key,value] of Object.entries(cfg.policies)) if(key.endsWith('ApprovalId') && !value) throw new Error(`OPEN_DECISION_${key}`);
  const d=cfg.destination,T=BigInt(d.scheduledT),listed=BigInt(d.listedAt),grace=BigInt(d.invalidRule.captureGraceSecs),voidSecs=BigInt(d.invalidRule.voidSecs);
  if(T<listed+86400n || T+grace>listed+voidSecs) throw new Error('INELIGIBLE_LISTING_HORIZON');
  if(BigInt(cfg.requiredFeedUntil)<T || nowSeconds>BigInt(cfg.requiredFeedUntil)) throw new Error('BAD_REQUIRED_FEED_UNTIL');
  // No runtime policy adapters have received the required external approvals yet.
  throw new Error('OPERATIONAL_POLICY_ADAPTERS_NOT_APPROVED: read-only diagnostics only');
}

export function verifyListing(cfg:MarketConfig,listing:Record<string,unknown>):void {
  const d=cfg.destination; if(!d) throw new Error('MISSING_DESTINATION');
  const pins={marketId:d.marketId,indexSourceId:d.sourceId,indexSigner:d.signerAddress,indexRulesHash:d.sourceRulesHash,depthNLots:cfg.pricing.depthNLots,maxSpreadWad:cfg.pricing.maxSpreadWad,scheduledT:d.scheduledT,listedAt:d.listedAt};
  for(const [key,value] of Object.entries(pins)) if(String(listing[key]).toLowerCase()!==value.toLowerCase()) throw new Error(`LISTING_PIN_MISMATCH_${key}`);
  const rule=record(listing.invalidRule);
  for(const [key,value] of Object.entries(d.invalidRule)) if(String(rule[key]).toLowerCase()!==String(value).toLowerCase()) throw new Error(`INVALID_RULE_MISMATCH_${key}`);
}
