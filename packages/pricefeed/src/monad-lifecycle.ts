import { performance } from 'node:perf_hooks';
import { setTimeout as pause } from 'node:timers/promises';
import type { MarketConfig } from './config.js';
import type { LifecycleReader, LifecycleView } from './lifecycle.js';
import { MonadTestnetLifecycleMonitor, validateMonadLifecycleConfig } from './lifecycle.js';
import { parseEngineReadAbi, preflightMonadTestnet, type MonadReadRpc } from './monad-preflight.js';

/** Snapshot the dossier once. Every refresh must pass the same named-block preflight.
 * Only fixed diagnostic reasons are persisted; provider messages can contain credentials.
 */
export function monadLifecycleReader(rpc:MonadReadRpc,config:MarketConfig,engineAbi:unknown,
  now:()=>bigint=()=>BigInt(Date.now())):LifecycleReader {
  const cfg=validateMonadLifecycleConfig(config),parsed=parseEngineReadAbi(engineAbi);
  if(parsed.abiHash.toLowerCase()!==cfg.destination!.abiHash.toLowerCase())throw new Error('MONAD_ABI_PIN_MISMATCH');
  return async()=>{
    try{
      const result=await preflightMonadTestnet(rpc,{config:cfg,abi:parsed.abi},now),engine=result.engine;
      if(!engine)throw new Error('LIFECYCLE_PIN_MISMATCH');
      return {...engine.lifecycle,sourceState:{lastSequence:engine.sourceState.lastSequence,lastObservedAt:engine.sourceState.lastObservedAt}};
    }catch(error){
      const reason=error instanceof Error?error.message:'';
      if(/^MONAD_(WRONG_CHAIN|ABI_PIN_MISMATCH|CODE_PIN_MISMATCH|LISTING_PIN_MISMATCH|SOURCE_PIN_MISMATCH|SOURCE_NOT_CONFIGURED|ENGINE_CODE_MISSING)$/.test(reason))
        throw new Error('LIFECYCLE_PIN_MISMATCH');
      if(reason==='MONAD_BLOCK_CHANGED')throw new Error('LIFECYCLE_REORG');
      if(/^MONAD_(BAD_BLOCK|BAD_SOURCE_STATE|SOURCE_STATE_CONTRADICTION|BAD_HALT_STATE)$/.test(reason))throw new Error('LIFECYCLE_BAD_CHECKPOINT');
      if(reason==='MONAD_STALE_OR_FUTURE_BLOCK')throw new Error('LIFECYCLE_CLOCK_OR_STALE_BLOCK');
      // Both expected outages and unexpected reader errors are redacted and fail closed.
      throw new Error('LIFECYCLE_RPC_UNAVAILABLE');
    }
  };
}

/** Serial checks on a monotonic schedule. Writes are complete before callbacks.
 * STOPPED/QUARANTINED are terminal until explicit operator review; no auto-reset.
 */
export async function watchMonadLifecycle(monitor:MonadTestnetLifecycleMonitor,intervalMs:number,signal:AbortSignal,
  onState:(view:LifecycleView)=>void|Promise<void>):Promise<void> {
  if(!Number.isSafeInteger(intervalMs)||intervalMs<1000||intervalMs>60000)throw new Error('MONAD_BAD_MONITOR_INTERVAL');
  while(!signal.aborted){
    const start=performance.now(),view=await monitor.check();
    await onState(view);
    if(view.mode==='STOPPED'||view.mode==='QUARANTINED'||signal.aborted)return;
    const delay=Math.max(0,intervalMs-(performance.now()-start));
    if(delay)try{await pause(delay,undefined,{signal});}catch(error){if(signal.aborted)return;throw error;}
  }
}
