import { readFileSync } from 'node:fs';
import { privateKeyToAccount } from 'viem/accounts';
import type { Hex } from 'viem';
import { rulesHash, type RulesManifest } from '../src/rules.js';
import { prepareObservation, DEVELOPMENT_POLICIES, type RawSigner } from '../src/publication.js';
import { parseConfig, type MarketConfig } from '../src/config.js';
import { metadataIdentity, verifyEventMembership } from '../src/collector.js';
import { createHash } from 'node:crypto';

export const h=(byte:string)=>'0x'+byte.repeat(32);
export const key=('0x'+'11'.repeat(32)) as Hex; // Public deterministic fixture only.
export const account=privateKeyToAccount(key);
export const base=parseConfig(JSON.parse(readFileSync(new URL('../../config/crypto.example.json',import.meta.url),'utf8')));
export const manifest:RulesManifest={schemaVersion:'1',venue:'polymarket',marketId:h('01'),sourceId:h('02'),
  eventId:base.mapping.eventId,externalMarketId:base.mapping.externalMarketId,conditionId:base.mapping.conditionId,
  outcomeTokenId:base.mapping.outcomeTokenId,outcomeLabel:'Yes',erosRulesHash:h('03'),externalRulesDigest:h('04'),
  quotePolicyHash:h('05'),quantityPolicyHash:h('06'),timestampPolicyHash:h('07'),failurePolicyHash:h('08'),
  scheduledT:'100000',depthNLots:'5000',maxSpreadWad:'50000000000000000',pricingPolicy:'before-fee-vwap-bid-floor-ask-ceil-mid-floor-depth-total-floor-v1'};
export const cfg:MarketConfig={...base,pricing:{depthNLots:'5000',maxSpreadWad:manifest.maxSpreadWad,impactMethod:'vwap'},
  destination:{chainId:'31337',engineAddress:'0x1111111111111111111111111111111111111111',engineCodeHash:h('aa'),abiHash:h('bb'),
    marketId:manifest.marketId,sourceId:manifest.sourceId,sourceRulesHash:rulesHash(manifest),signerAddress:account.address,
    listedAt:'0',scheduledT:manifest.scheduledT,invalidRule:{fallbackListed:true,captureGraceSecs:'3600',voidSecs:'2592000',fallbackPriceWad:'500000000000000000'}}};
export const metadata={id:base.mapping.externalMarketId,conditionId:base.mapping.conditionId,outcomes:['Yes','No'],
  clobTokenIds:[base.mapping.outcomeTokenId,'2'],question:'Fixture question',description:'Fixture rules',active:true,closed:false,enableOrderBook:true,acceptingOrders:true};
export const event={id:base.mapping.eventId,markets:[{id:base.mapping.externalMarketId}],active:true,closed:false};
export const body=JSON.stringify({market:base.mapping.conditionId,asset_id:base.mapping.outcomeTokenId,timestamp:'1000000',hash:'vendor',
  tick_size:'0.01',min_order_size:'5',bids:[{price:'0.59',size:'6'}],asks:[{price:'0.61',size:'6'}]});
export const marketIdentity=metadataIdentity(cfg,metadata),eventIdentity=verifyEventMembership(cfg,event);
export const rulesDigest=createHash('sha256').update(`${eventIdentity.rulesDigest}:${marketIdentity.rulesDigest}`).digest('hex');
export const reviewed={...manifest,...DEVELOPMENT_POLICIES,externalRulesDigest:'0x'+rulesDigest};
export const config={...cfg,destination:{...cfg.destination!,sourceRulesHash:rulesHash(reviewed)}};
export const candidate=(sequence:bigint,now=1000100n)=>prepareObservation(config,reviewed,{bookBody:body,metadata,event,
  bookReceivedAtMs:1000050n,metadataReceivedAtMs:1000000n,eventReceivedAtMs:1000000n},sequence,now,1000n);
export const signer:RawSigner={address:account.address,signDigest:async(request)=>account.sign({hash:request.digest})};

