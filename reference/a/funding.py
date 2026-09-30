from dataclasses import dataclass, replace
from reference.common.units import Q

@dataclass(frozen=True)
class Epoch:
    start: int
    end: int
    last: int
    rate: int
    index: int
    budget: int
    cushion: int = 0
    clearing: int = 0
    stopped: bool = False

def open_epoch(start,end,rate,oi,slack):
    if end<=start or min(oi,slack)<0: raise ValueError('bad epoch')
    budget=min(slack,oi*abs(rate)*(end-start))
    return Epoch(start,end,start,rate,0,budget,stopped=oi==0 or rate==0)

def advance(e:Epoch,now:int,fresh_through:int,deadline:int,oi:int,reserve_lots:int):
    if now<e.last or oi<abs(reserve_lots): raise ValueError('bad interval/OI')
    if e.stopped: return e,0
    cutoff=min(now,e.end,fresh_through,deadline)
    if cutoff<e.last: cutoff=e.last
    elapsed=cutoff-e.last
    affordable=e.budget//(oi*abs(e.rate)) if oi and e.rate else 0
    dt=min(elapsed,affordable)
    df=e.rate*dt
    flow=oi*abs(df); rp=reserve_lots*df
    stopped=(oi==0 or affordable<=elapsed or cutoff<now or cutoff==e.end or cutoff==deadline)
    return replace(e,last=e.last+dt,index=e.index+df,budget=e.budget-flow,
                   cushion=e.cushion+flow-max(rp,0),clearing=e.clearing+rp,stopped=stopped),rp

def sync(e:Epoch,lots:int,checkpoint:int,cash_q:int):
    p=lots*(e.index-checkpoint)
    if max(p,0)>e.cushion: raise ValueError('unattributed payer flow')
    return replace(e,cushion=e.cushion-max(p,0),clearing=e.clearing+p),cash_q-p,e.index
