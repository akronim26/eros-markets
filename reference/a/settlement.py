from fractions import Fraction as F
from reference.common.units import Q
from reference.a.ledger import equity

def payout(a,price):return int(max(0,equity(a,F(price)))//Q)

def fee_commitment(value_q,fee_wad):
    if min(value_q,fee_wad)<0:raise ValueError('negative fee')
    return (value_q*fee_wad+Q-1)//Q

def fee_fragment(cap,total_lots,filled_before,filled_after):
    if not 0<=filled_before<=filled_after<=total_lots or total_lots==0:raise ValueError('fill bounds')
    return cap*filled_after//total_lots-cap*filled_before//total_lots

def allocation(asset_q,claims_atoms,protocol_q,keeper_q,shares):
    residual=asset_q-sum(claims_atoms)*Q-protocol_q-sum(keeper_q)
    if residual<0:raise ValueError('RECOVERY_REQUIRED')
    if any(s<0 for s in shares):raise ValueError('negative shares')
    total=sum(shares); atoms=residual//Q
    payouts=[atoms*s//total if total else 0 for s in shares]
    treasury=residual-sum(payouts)*Q
    return payouts,treasury

def recovery(raw_claims_q,available_q):
    if min([available_q]+raw_claims_q)<0:raise ValueError('negative assets/claims')
    total=sum(raw_claims_q)
    if not total:return [0]*len(raw_claims_q)
    return [c*min(total,available_q)//(total*Q) for c in raw_claims_q]

def backstop(seed_atoms,prefunded_atoms,shortfall_atoms):
    return min(seed_atoms//5,prefunded_atoms,shortfall_atoms)
