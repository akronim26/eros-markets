#!/usr/bin/env python3
"""Independent Fraction expectations derived from the plan; no TS/Solidity imports."""
import json, sys
from fractions import Fraction as F
from pathlib import Path
from random import Random
W=10**18
root=Path(__file__).resolve().parent.parent

def expected(name,bids,asks,nlots,spread,method):
 def side(rows,reverse):
  agg={}
  for p,q in rows:
   p,q=F(p),F(q)
   if q: agg[p]=agg.get(p,F(0))+q
  return sorted(agg.items(),reverse=reverse)
 b,a=side(bids,True),side(asks,False)
 def walk(rows,isask):
  left=F(nlots,1000); value=F(0)
  for price,size in rows:
   take=min(left,size);left-=take;value+=price*take
   if not left:
    x=price*W if method=='marginal' else value*W/F(nlots,1000)
    return -(-x.numerator//x.denominator) if isask else x.numerator//x.denominator
  return None
 bid,ask=walk(b,False),walk(a,True)
 bd=int(sum((q for p,q in b),F(0))*1000);ad=int(sum((q for p,q in a),F(0))*1000)
 valid=bd>=nlots and ad>=nlots and bid is not None and ask is not None and 0<bid<=ask<W and ask-bid<=spread
 conv=lambda x:None if x is None else str(x)
 return dict(name=name,bids=[dict(price=p,size=q) for p,q in bids],asks=[dict(price=p,size=q) for p,q in asks],nLots=str(nlots),spreadWad=str(spread),method=method,bidWad=conv(bid),askWad=conv(ask),midWad=conv((bid+ask)//2) if valid else None,valid=valid,bidDepthLots=str(bd),askDepthLots=str(ad))

vectors=[]
for method in ('vwap','marginal'):
 cases=[('method-discriminator',[('0.60','6'),('0.58','4')],[('0.62','6'),('0.64','4')],10000,5*10**16),
 ('spread-equality',[('0.59','5')],[('0.64','5')],5000,5*10**16),
 ('spread-one-atom',[('0.59','5')],[('0.640000000000000001','5')],5000,5*10**16),
 ('odd-midpoint',[('0.590000000000000001','5')],[('0.590000000000000002','5')],5000,5*10**16),
 ('thin',[('0.60','4.999')],[('0.61','5')],5000,5*10**16),
 ('endpoint',[('0','5')],[('1','5')],5000,W),
 ('crossed',[('0.62','5')],[('0.61','5')],5000,5*10**16),
 ('partial-final',[('0.6','6'),('0.58','7')],[('0.62','6'),('0.64','7')],8000,5*10**16)]
 for name,b,a,n,s in cases: vectors.append(expected(name+'-'+method,b,a,n,s,method))
rng=Random(20261002)
for i in range(64):
 b=[(f'0.{rng.randint(100,490):03}',str(rng.randint(1,15))) for _ in range(5)]
 a=[(f'0.{rng.randint(510,900):03}',str(rng.randint(1,15))) for _ in range(5)]
 for method in ('vwap','marginal'):
  vectors.append(expected(f'random-{i}-{method}',b,a,rng.randint(1,60)*1000,W,method))
encoded=json.dumps(vectors,indent=2)+'\n'
path=root/'fixtures/impact.json'
if '--check' in sys.argv:
 if path.read_text()!=encoded: raise SystemExit('Independent fixtures differ')
 print(f'PASS: {len(vectors)} independently derived impact vectors (seed 20261002)')
else:
 path.write_text(encoded); print(f'Generated {len(vectors)} independent fixtures')
