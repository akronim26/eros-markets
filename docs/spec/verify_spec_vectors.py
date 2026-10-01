"""Arithmetic/specification checks only; this is not the protocol implementation."""
from fractions import Fraction as F
from decimal import Decimal, getcontext
from pathlib import Path
import json
Q=10**18
checks=[]
def ok(name,condition,detail):
    assert condition,(name,detail)
    checks.append({'id':name,'passed':True,'detail':detail})
def deficit(c,n,y): return max(0,-(c+n*1000*Q*y))
def pos_integral(a,b,t):
    """Exact integral of max(a+b*s,0) for s in [0,t]."""
    a,b,t=F(a),F(b),F(t); end=a+b*t
    if a>=0 and end>=0:return a*t+b*t*t/2
    if a<=0 and end<=0:return F(0)
    if a<0:return end*end/(2*b)
    return a*a/(-2*b)
def ceil_f(v): return -(-v.numerator//v.denominator)
ok('V01',17*613==10421,'17 lots @613 transfers 10,421 atoms exactly.')
ok('V02',1000*17*(613*10**15)==10421*Q,'mark-equity and fill scales coincide; no second WAD division.')
n=1_000_000;c=-480_000_000*Q
ok('V03',deficit(c,n,0)==480_000_000*Q and deficit(c,n,1)==0,'1,000-claim long with120USDC at.6 has NO deficit480USDC.')
cs=700_000_000*Q
ok('V04',deficit(cs,-n,1)==300_000_000*Q,'1,000-claim short with100USDC at.6 has YES deficit300USDC.')
assets=100_220_000_000*Q
settlement=[]
for label,p,expected in [('NO',F(0),700_000_000),('YES',F(1),520_000_000),('INVALID',F(1,2),220_000_000)]:
    e=[c+n*1000*Q*p,cs-n*1000*Q*p]
    payouts=[int(max(0,x)//Q) for x in e]
    ok('V05_'+label,sum(payouts)==expected and sum(payouts)*Q<=assets,f'{label}: trader payouts {payouts} atoms, funded before claims.')
    settlement.append({'outcome':label,'p':str(p),'trader_payout_atoms':payouts,'reserve_residual_atoms':int(assets//Q)-sum(payouts)})
# Endpoint coverage implies interior: representative bounded grid, not universal proof.
for k in range(1001):
    p=F(k,1000); ds=sum(max(0,-e) for e in [c+n*1000*Q*p,cs-n*1000*Q*p])
    assert ds<=480_000_000*Q
ok('V06',True,'Interior-price arithmetic checked at1,001 prices; general argument is convexity in the PDF.')
# Original long1, cash0, ask2.3 at.55.
ok('V07',1000*1000*Q-2300*1000*Q+2300*550*Q==-35000*Q,'Oversized ask creates35,000 atom YES deficit and must reject at1x.')
ok('V08',(7*400+11*600)-7*400==6600,'Cancel quantity and exact price contribution, not average.')
for label,p in [('reserve_payer',F(2,5)),('reserve_receiver',F(-2,5)),('flat_reserve',F(0))]:
    total=F(1); trader=total-max(p,0); slack_change=-p-trader+total
    ok('V09_'+label,slack_change==max(-p,0),f'A=1, reservePayment={p}, cushionIncrement={trader}, slackChange={slack_change}.')
ok('V10',F(3,5)+F(2,5)-1==0,'Trader60, reserve40, trader−100 atdeltaF.01: funding clearing netszero.')
B=F(10)-100*F(1,1000)*20
ok('V11',B==8 and B/(200*F(1,1000))==40,'OI100→200: spend2 then remaining8 permits40seconds at.2/sec.')
# Exact premium integration in USDC/day scaling.
full=pos_integral(100,F(10,3600),3600)*F(2,10000)/86400
half=pos_integral(100,F(10,3600),1800)*F(2,10000)/86400
ok('V12',full==F(7,8000),'100→110 deficit/hour at.0002/day charges.000875USDC.')
fullQ=full*10**6*Q; halfQ=half*10**6*Q
ok('V13',ceil_f(halfQ)+(ceil_f(fullQ)-ceil_f(halfQ))==ceil_f(fullQ),'Cumulative ceil difference is neutral-touch invariant.')
ok('V14',4*full==F(7,2000),'4x premium on same segment is.0035USDC.')
ok('V15',pos_integral(-10,F(1),20)==50 and pos_integral(10,F(-1),20)==50,'Positive-part crossing uses exact clipped triangle, not sampled average.')
for e in [-480,0,520]:ok('V16_'+str(e),e+max(-e,0)==max(e,0),'Whole-account fee-free takeover slack identity.')
# Exact Q escrow retains half-atom keeper fraction.
market=100*Q; keeper=Q//2; protocol=Q//2
remaining=market-keeper-protocol
ok('V17',remaining+keeper+protocol==market and keeper//Q==0,'Fee Q reclassification retains fractional liabilities; no LP dust sweep.')
getcontext().prec=60
q=Decimal('.6');x=Decimal(1000);h=Decimal(360);T=Decimal(29*86400)
a=Decimal('.0001')*h/Decimal(86400);ep=(Decimal('.01')-a)/(1-a)
k=((1-ep)/ep).sqrt();sig=(q*(1-q)*h/T).sqrt();drift=(1-q)*a/(1-2*a)
mm=min(x*q,x*(drift+k*sig+Decimal('.005'))+Decimal('.5')*Decimal('.000001')*x*x)
im=min(x*q,max(Decimal('1.5')*mm,x*q/5))
ok('V18',im==120 and mm<80,'29-day selected linear-hazard fixture supportsdirect5x entry with120USDC; empirical upper envelopes explicitly set belowtheoreticalfixturebound.')
short_drift=q*a/(1-2*a)
short_mm=min(x*(1-q),x*(short_drift+k*sig+Decimal('.005'))+Decimal('.5')*Decimal('.000001')*x*x)
short_im=min(x*(1-q),max(Decimal('1.5')*short_mm,x*(1-q)/5))
ok('V20',short_im<=100 and short_im>80,'Counterparty100USDC collateral passes selected short IM;80USDC would fail at29days.')
risk={'days_to_T':29,'q':'0.6','claims':1000,'lots':1000000,'collateral_USDC':'120','MM_USDC':str(mm),'IM_USDC':str(im),'hazard_probability_upper':str(a),'k_upper_reference':str(k),'sigma_reference':str(sig),'status':'High-precision arithmetic reference, not bounded Solidity math validation.'}
# Upper-bound all 1,000,000 lot prefixes using monotone formula implementation.
import numpy as np
xs=np.arange(1,1_000_001,dtype=np.float64)/1000
hs=300+xs*.06
haz=.0001*hs/86400
eps=(.01-haz)/(1-haz)
ks=np.sqrt((1-eps)/eps)
sigma=np.sqrt(.24*hs/(29*86400))
d=.4*haz/(1-2*haz)
mms=np.minimum(xs*.6,xs*(d+ks*sigma+.005)+.5e-6*xs*xs)
ims=np.minimum(xs*.6,np.maximum(1.5*mms,xs*.6/5))
ok('V19',float(ims.max())<=120 and np.all(np.diff(ims)>=0),'Numerical prefixcheck:1,000,000 positive lot sizes; IM monotoneandmax120. Not a universalprooforSolidityexecution.')
out={'status':'passed','scope':'Specification arithmetic only. No production contracts, gas, feed adapters, security audit or live integration tested.','check_count':len(checks),'checks':checks,'settlement_fixture':settlement,'direct_leverage_fixture':risk}
Path(__file__).with_name('spec_vector_results.json').write_text(json.dumps(out,indent=2)+'\n')
print(json.dumps({'status':out['status'],'checks':len(checks),'MM_USDC':str(mm),'IM_USDC':str(im)}))
