from dataclasses import dataclass
from reference.common.units import Q, PAYOFF_Q_PER_LOT as U
from reference.a.ledger import Account

@dataclass(frozen=True)
class Orders:
    bid_lots: int = 0
    bid_value_q: int = 0
    ask_lots: int = 0
    ask_value_q: int = 0
    fee_q: int = 0

def deficits(a: Account, orders: Orders = Orders()):
    if min(orders.bid_lots,orders.bid_value_q,orders.ask_lots,orders.ask_value_q,orders.fee_q)<0:
        raise ValueError('negative reservation')
    c=a.cash_q-orders.fee_q
    return max(0,orders.bid_value_q-c),max(0,-(c+U*(a.lots-orders.ask_lots)+orders.ask_value_q))

def slacks(reserve: Account, d0, d1, cushion=0, budget=0):
    if min(d0,d1,cushion,budget)<0: raise ValueError('negative liability')
    return reserve.cash_q-d0-cushion-budget,reserve.cash_q+U*reserve.lots-d1-cushion-budget

def concentration_ok(d0,d1,seed_q):
    return max(d0,d1)*50 <= seed_q
