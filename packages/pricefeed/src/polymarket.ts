import { record } from './book.js';
import type { MarketConfig } from './config.js';
import { uint } from './math.js';

export type Capture={url:string;receivedAtMs:bigint;latencyMs:bigint;body:string;headers:Record<string,string>;data:Record<string,unknown>;attempts:number};
export type Fetcher=(url:string,init:RequestInit)=>Promise<Response>;
const wait=(ms:number)=>new Promise<void>(resolve=>setTimeout(resolve,ms));
// Bound each transport await even when a custom transport ignores AbortSignal.
function bounded<T>(operation:Promise<T>,signal:AbortSignal):Promise<T> {
  return new Promise<T>((resolve,reject)=>{
    const abort=()=>{signal.removeEventListener('abort',abort);reject(signal.reason);};
    signal.addEventListener('abort',abort,{once:true});
    if(signal.aborted)abort();
    operation.then(resolve,reject).finally(()=>signal.removeEventListener('abort',abort));
  });
}

export class RequestLimiter {
  private tail:Promise<void>=Promise.resolve(); private pending=0; private nextStart=0;
  constructor(private readonly minimumIntervalMs:number,private readonly maxPending:number) {
    if(!Number.isSafeInteger(minimumIntervalMs)||minimumIntervalMs<0||!Number.isSafeInteger(maxPending)||maxPending<1) throw new Error('BAD_RATE_LIMIT');
  }
  async acquire():Promise<void> {
    if(this.pending>=this.maxPending) throw new Error('PROVIDER_QUEUE_FULL');
    this.pending++;
    const entry=this.tail.then(async()=>{const delay=this.nextStart-Date.now();if(delay>0)await wait(delay);this.nextStart=Date.now()+this.minimumIntervalMs;});
    this.tail=entry.catch(()=>{});
    try{await entry;}finally{this.pending--;}
  }
}

export class PublicPolymarket {
  constructor(private readonly options:MarketConfig['poll'],private readonly limiter:RequestLimiter,
    private readonly fetcher:Fetcher=(url,init)=>fetch(url,init)) {}
  async request(url:string):Promise<Capture> {
    const target=new URL(url);
    if(target.protocol!=='https:'||!['gamma-api.polymarket.com','clob.polymarket.com'].includes(target.hostname)
       ||target.username||target.password||target.port||target.hash) throw new Error('HOST_NOT_ALLOWED');
    let last:unknown;
    for(let attempt=0;attempt<=this.options.maxRetries;attempt++) {
      await this.limiter.acquire();
      const started=process.hrtime.bigint();
      const controller=new AbortController();
      const timer=setTimeout(()=>controller.abort(new Error('SOURCE_TIMEOUT')),this.options.timeoutMs);
      try {
        const response=await bounded(this.fetcher(target.href,{method:'GET',redirect:'manual',signal:controller.signal}),controller.signal);
        if(response.status!==200) {
          void response.body?.cancel().catch(()=>{});
          const err=new Error(`HTTP_${response.status}`);
          if(response.status!==429&&response.status<500) throw Object.assign(err,{noRetry:true});
          throw err;
        }
        const declared=response.headers.get('content-length');
        if(declared&&(!/^\d+$/.test(declared)||BigInt(declared)>BigInt(this.options.bodyLimitBytes))) {
          void response.body?.cancel().catch(()=>{});
          throw Object.assign(new Error('RESPONSE_TOO_LARGE'),{noRetry:true});
        }
        if(!response.body)throw new Error('EMPTY_RESPONSE');
        const reader=response.body.getReader();let size=0;const chunks:Uint8Array[]=[];
        try {
          for(;;){const next=await bounded(reader.read(),controller.signal);if(next.done)break;size+=next.value.byteLength;
            if(size>this.options.bodyLimitBytes){throw Object.assign(new Error('RESPONSE_TOO_LARGE'),{noRetry:true});}
            chunks.push(next.value);}
        } catch(error) {
          void reader.cancel().catch(()=>{});throw error;
        } finally {reader.releaseLock();}
        const joined=new Uint8Array(size);let offset=0;
        for(const chunk of chunks){joined.set(chunk,offset);offset+=chunk.byteLength;}
        const body=new TextDecoder('utf-8',{fatal:true}).decode(joined);
        const data=record(JSON.parse(body));
        const headers:Record<string,string>={};
        for(const key of ['date','age','cache-control','content-type','etag']){const value=response.headers.get(key);if(value!==null)headers[key]=value;}
        return {url:target.href,receivedAtMs:BigInt(Date.now()),latencyMs:(process.hrtime.bigint()-started)/1000000n,body,headers,data,attempts:attempt+1};
      } catch(error) {
        last=error;
        if(error&&typeof error==='object'&&'noRetry' in error) throw error;
        if(attempt<this.options.maxRetries) await wait(this.options.retryDelayMs*2**attempt);
      } finally {clearTimeout(timer);}
    }
    throw last;
  }
  book(tokenId:string):Promise<Capture>{uint(tokenId,256);return this.request(`https://clob.polymarket.com/book?token_id=${tokenId}`);}
  metadata(marketId:string):Promise<Capture>{uint(marketId,256);return this.request(`https://gamma-api.polymarket.com/markets/${marketId}`);}
  event(eventId:string):Promise<Capture>{uint(eventId,256);return this.request(`https://gamma-api.polymarket.com/events/${eventId}`);}
  tag(slug:string):Promise<Capture>{
    if(!/^[a-z0-9][a-z0-9-]{0,79}$/.test(slug))throw new Error('BAD_DISCOVERY_TAG');
    return this.request(`https://gamma-api.polymarket.com/tags/slug/${slug}`);
  }
  eventsPage(tagId:string,limit:number,cursor:string|null=null):Promise<Capture>{
    uint(tagId,256);
    if(!Number.isSafeInteger(limit)||limit<1||limit>100)throw new Error('BAD_DISCOVERY_LIMIT');
    if(cursor!==null&&(typeof cursor!=='string'||cursor.length===0||cursor.length>8192||/\s/.test(cursor)))throw new Error('BAD_DISCOVERY_CURSOR');
    const url=new URL('https://gamma-api.polymarket.com/events/keyset');
    url.searchParams.set('closed','false');url.searchParams.set('limit',String(limit));url.searchParams.set('tag_id',tagId);
    if(cursor!==null)url.searchParams.set('after_cursor',cursor);
    return this.request(url.href);
  }
}
