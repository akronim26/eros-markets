"""Independent exact ledger arithmetic; no Solidity calls or token custody."""
from dataclasses import dataclass
from fractions import Fraction as F
from reference.common.units import Q, PAYOFF_Q_PER_LOT, checked_position_lots, checked_cash_q, checked_tick

@dataclass(frozen=True)
class Account:
    lots: int = 0
    cash_q: F = F(0)

def equity(a: Account, price: F) -> F:
    if not 0 <= price <= 1:
        raise ValueError('price outside payoff domain')
    return a.cash_q + a.lots * PAYOFF_Q_PER_LOT * price

def fill(buyer: Account, seller: Account, lots: int, tick: int, buyer_fee=0, seller_fee=0):
    if lots <= 0 or min(buyer_fee, seller_fee) < 0:
        raise ValueError('bad size or fees')
    value = lots * checked_tick(tick) * Q
    b = Account(checked_position_lots(buyer.lots + lots), buyer.cash_q-value-buyer_fee)
    s = Account(checked_position_lots(seller.lots - lots), seller.cash_q+value-seller_fee)
    for a in (b,s):
        if abs(a.cash_q) >= 2**180: raise ValueError('cash bound')
    return b,s,buyer_fee+seller_fee

def takeover(trader: Account, reserve: Account):
    return Account(), Account(checked_position_lots(reserve.lots+trader.lots), reserve.cash_q+trader.cash_q)
