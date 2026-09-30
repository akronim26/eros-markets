from dataclasses import dataclass, replace
from reference.a.coverage import deficits
from reference.a.ledger import Account

@dataclass(frozen=True)
class PremiumState:
    epoch:int
    cash_q:int
    paid:int=0
    surcharge_until:int=0
    capitalized_epoch:int=0

def post(state,charge):
    if charge<0:raise ValueError('negative charge')
    return replace(state,cash_q=state.cash_q-charge,paid=state.paid+charge)

def principal(state):return state.cash_q+state.paid

def mutate(state,lots_before,lots_after,new_cash_q,now):
    before=deficits(Account(lots_before,principal(state)))
    after=deficits(Account(lots_after,new_cash_q+state.paid))
    expiry=now+21600 if any(a>b for a,b in zip(after,before)) else state.surcharge_until
    return replace(state,cash_q=new_cash_q,surcharge_until=expiry)

def capitalize(state,next_epoch):
    if next_epoch==state.epoch:return state
    if next_epoch!=state.epoch+1:raise ValueError('epoch skipped')
    return replace(state,epoch=next_epoch,paid=0,capitalized_epoch=state.epoch)
