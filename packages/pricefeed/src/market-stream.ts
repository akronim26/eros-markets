import type { MarketConfig } from './config.js';
import { uint } from './math.js';

export const MARKET_STREAM_URL='wss://ws-subscriptions-clob.polymarket.com/ws/market';
export type StreamSocket={send(data:string):void;close():void;
  addEventListener(type:string,listener:EventListener):void;removeEventListener(type:string,listener:EventListener):void};
export type StreamWorker={config:MarketConfig;requestStreamRefresh(generation:number,reason:string,resync:boolean):void};
type StreamTarget={worker:StreamWorker;token:string;condition:string};
type RoutedHint={reason:string;targets:StreamTarget[]};
export type StreamPolicy={connectTimeoutMs:number;heartbeatMs:number;pongTimeoutMs:number;
  reconnectBaseMs:number;reconnectMaxMs:number;maxFrameBytes:number;maxEvents:number};
/** Diagnostic transport settings; no production cadence or timestamp policy is approved. */
export const DIAGNOSTIC_STREAM_POLICY:StreamPolicy={connectTimeoutMs:5000,heartbeatMs:10000,pongTimeoutMs:5000,
  reconnectBaseMs:1000,reconnectMaxMs:30000,maxFrameBytes:1000000,maxEvents:1000};
export type StreamView={state:'STOPPED'|'CONNECTING'|'CONNECTED'|'BACKOFF';generation:number;reason:string|null;
  connections:number;disconnects:number;pongs:number;acceptedEvents:number;ignoredEvents:number;rejectedFrames:number;hintRequests:number};
function object(value:unknown):Record<string,unknown>{
  if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('STREAM_BAD_FRAME');return value as Record<string,unknown>;
}
function token(value:unknown):string {uint(value,256);return value as string;}
function condition(value:unknown):string {
  if(typeof value!=='string'||!/^0x[\da-fA-F]{64}$/.test(value))throw new Error('STREAM_BAD_FRAME');return value.toLowerCase();
}
function delay(ms:number,signal:AbortSignal):Promise<void>{
  if(signal.aborted)return Promise.resolve();
  return new Promise(resolve=>{const done=()=>{clearTimeout(timer);signal.removeEventListener('abort',done);resolve();};
    const timer=setTimeout(done,ms);signal.addEventListener('abort',done,{once:true});});
}

/** Hints only: prices, hashes and vendor timestamps from this transport are never calculated or signed. */
export class MarketStreamHints {
  private running=false;
  private endSession:((reason:string)=>void)|null=null;
  private readonly policy:StreamPolicy;
  private readonly targets:StreamTarget[];
  private view:StreamView={state:'STOPPED',generation:0,reason:null,connections:0,disconnects:0,pongs:0,
    acceptedEvents:0,ignoredEvents:0,rejectedFrames:0,hintRequests:0};
  constructor(workers:readonly StreamWorker[],policy:StreamPolicy=DIAGNOSTIC_STREAM_POLICY,
    private readonly socketFactory:(url:string)=>StreamSocket=url=>new WebSocket(url),
    private readonly onState:(view:StreamView)=>void=()=>{},private readonly random:()=>number=Math.random){
    this.policy={...policy};
    const bounds:Record<keyof StreamPolicy,[number,number]>={connectTimeoutMs:[1,30000],heartbeatMs:[1,10000],
      pongTimeoutMs:[1,30000],reconnectBaseMs:[1,30000],reconnectMaxMs:[1,60000],maxFrameBytes:[100,2000000],maxEvents:[1,1000]};
    for(const [key,[min,max]] of Object.entries(bounds) as [keyof StreamPolicy,[number,number]][]){
      const v=policy[key];if(!Number.isSafeInteger(v)||v<min||v>max)throw new Error('BAD_STREAM_POLICY');
    }
    if(policy.reconnectMaxMs<policy.reconnectBaseMs||workers.length<1||workers.length>100
      ||new Set(workers.map(w=>w.config.key)).size!==workers.length)throw new Error('BAD_STREAM_WORKERS_OR_POLICY');
    this.targets=workers.map(worker=>({worker,token:token(worker.config.mapping.outcomeTokenId),condition:condition(worker.config.mapping.conditionId)}));
  }
  inspect():StreamView{return {...this.view};}
  /** Explicit diagnostic disconnect; ordinary recovery also handles closes, errors and missing PONG. */
  requestReconnect():void {this.endSession?.('STREAM_REQUESTED_RECONNECT');}
  private state(state:StreamView['state'],reason:string|null):void{
    this.view.state=state;this.view.reason=reason;this.onState(this.inspect());
  }
  private resync(reason:string):void {
    for(const target of this.targets){target.worker.requestStreamRefresh(this.view.generation,reason,true);this.view.hintRequests++;}
  }
  private parseHints(data:string):RoutedHint[] {
    if(Buffer.byteLength(data,'utf8')>this.policy.maxFrameBytes)throw new Error('STREAM_FRAME_TOO_LARGE');
    const parsed:unknown=JSON.parse(data),events=Array.isArray(parsed)?parsed:[parsed];
    if(events.length===0||events.length>this.policy.maxEvents)throw new Error('STREAM_BAD_FRAME');
    // Validate the entire batch first, so a malformed tail cannot partially apply a batch.
    const routed:RoutedHint[]=[];
    for(const raw of events){
      const event=object(raw),kind=event.event_type;
      if(typeof kind!=='string')throw new Error('STREAM_BAD_FRAME');
      if(!['book','price_change','last_trade_price','tick_size_change','best_bid_ask','market_resolved','new_market'].includes(kind)){
        routed.push({reason:kind,targets:[]});continue;
      }
      const market=condition(event.market);let tokens:string[];
      if(kind==='price_change'){
        if(!Array.isArray(event.price_changes)||event.price_changes.length<1||event.price_changes.length>this.policy.maxEvents)throw new Error('STREAM_BAD_FRAME');
        tokens=event.price_changes.map(change=>token(object(change).asset_id));
      }else if(kind==='market_resolved'||kind==='new_market'){
        if(!Array.isArray(event.assets_ids)||event.assets_ids.length<1||event.assets_ids.length>this.policy.maxEvents)throw new Error('STREAM_BAD_FRAME');
        tokens=event.assets_ids.map(token);
      }else tokens=[token(event.asset_id)];
      const assets=new Set(tokens);
      routed.push({reason:kind,targets:this.targets.filter(t=>t.condition===market&&assets.has(t.token))});
    }
    return routed;
  }
  private dispatchHints(routed:ReturnType<MarketStreamHints['parseHints']>):void {
    for(const event of routed){
      if(!event.targets.length){this.view.ignoredEvents++;continue;}
      this.view.acceptedEvents++;
      for(const target of event.targets){
        // Lifecycle/tick hints invalidate cached publication evidence immediately.
        const resync=['tick_size_change','market_resolved','new_market'].includes(event.reason);
        target.worker.requestStreamRefresh(this.view.generation,event.reason,resync);this.view.hintRequests++;
      }
    }
  }
  async run(signal:AbortSignal):Promise<void>{
    if(this.running)throw new Error('STREAM_ALREADY_RUNNING');this.running=true;
    let failures=0;
    try{
      while(!signal.aborted){
        this.view.generation++;this.resync('STREAM_CONNECTING');this.state('CONNECTING',null);
        const result=await this.session(signal);
        if(signal.aborted)break;
        this.view.disconnects++;this.resync(result.reason);this.state('BACKOFF',result.reason);
        // Only a successful heartbeat resets backoff, not a brief open/close storm.
        failures=result.healthy?0:Math.min(failures+1,16);
        const cap=Math.min(this.policy.reconnectMaxMs,this.policy.reconnectBaseMs*2**Math.max(0,failures-1));
        const jitter=this.random();if(!Number.isFinite(jitter)||jitter<0||jitter>1)throw new Error('BAD_STREAM_RANDOM');
        await delay(Math.max(1,Math.floor(cap*(0.5+jitter/2))),signal);
      }
    }finally{this.endSession=null;this.running=false;this.state('STOPPED',signal.aborted?'STREAM_ABORTED':'STREAM_FAILED');}
  }
  private session(signal:AbortSignal):Promise<{reason:string;healthy:boolean}>{
    return new Promise((resolve,reject)=>{
      let socket:StreamSocket;
      try{socket=this.socketFactory(MARKET_STREAM_URL);}catch{resolve({reason:'STREAM_CONNECT_FAILED',healthy:false});return;}
      const generation=this.view.generation;let ended=false,opened=false,healthy=false;
      let heartbeat:ReturnType<typeof setInterval>|undefined,pong:ReturnType<typeof setTimeout>|undefined;
      const current=()=>!ended&&generation===this.view.generation&&!signal.aborted;
      const finish=(reason:string,error?:unknown)=>{
        if(ended)return;ended=true;clearTimeout(connect);if(heartbeat)clearInterval(heartbeat);if(pong)clearTimeout(pong);
        signal.removeEventListener('abort',abort);
        for(const [name,listener] of listeners)socket.removeEventListener(name,listener);
        this.endSession=null;try{socket.close();}catch{/* Session is already detached. */}
        if(error)reject(error);else resolve({reason,healthy});
      };
      const abort=()=>finish('STREAM_ABORTED');
      const open:EventListener=()=>{
        if(!current()||opened)return;opened=true;clearTimeout(connect);
        try{socket.send(JSON.stringify({assets_ids:[...new Set(this.targets.map(t=>t.token))],type:'market',custom_feature_enabled:true}));}
        catch{finish('STREAM_SEND_FAILED');return;}
        try{
          this.view.connections++;this.resync('STREAM_CONNECTED');this.state('CONNECTED',null);
          heartbeat=setInterval(()=>{
            if(!current()||pong!==undefined)return;
            try{pong=setTimeout(()=>finish('STREAM_PONG_TIMEOUT'),this.policy.pongTimeoutMs);socket.send('PING');}
            catch{finish('STREAM_SEND_FAILED');}
          },this.policy.heartbeatMs);
        }catch(error){finish('STREAM_OPEN_FAILED',error);}
      };
      const message:EventListener=event=>{
        if(!current()||!opened)return;
        const data=(event as MessageEvent<unknown>).data;
        if(typeof data!=='string'){this.view.rejectedFrames++;finish('STREAM_BINARY_FRAME');return;}
        if(data==='PONG'){
          if(pong!==undefined){clearTimeout(pong);pong=undefined;healthy=true;this.view.pongs++;}return;
        }
        let routed:ReturnType<MarketStreamHints['parseHints']>;
        try{routed=this.parseHints(data);}catch(error){
          this.view.rejectedFrames++;finish(error instanceof Error&&error.message==='STREAM_FRAME_TOO_LARGE'?'STREAM_FRAME_TOO_LARGE':'STREAM_BAD_FRAME');
          return;
        }
        try{this.dispatchHints(routed);}catch(error){finish('STREAM_HANDLER_FAILED',error);}
      };
      const close:EventListener=()=>finish('STREAM_CLOSED'),error:EventListener=()=>finish('STREAM_ERROR');
      const listeners:[string,EventListener][]=[['open',open],['message',message],['close',close],['error',error]];
      const connect=setTimeout(()=>finish('STREAM_CONNECT_TIMEOUT'),this.policy.connectTimeoutMs);
      this.endSession=reason=>finish(reason);
      for(const [name,listener] of listeners)socket.addEventListener(name,listener);
      signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();
    });
  }
}
