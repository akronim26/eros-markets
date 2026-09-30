from fractions import Fraction as F
from reference.common.units import Q, PAYOFF_Q_PER_LOT as U, SECONDS_PER_DAY

def positive_integral(a,b,duration):
    a,b,t=F(a),F(b),F(duration)
    if t<0: raise ValueError('negative duration')
    end=a+b*t
    if a>=0 and end>=0:return (a+end)*t/2
    if a<=0 and end<=0:return F(0)
    if a<0:return end*end/(2*b)
    return a*a/(-2*b)

def cumulative(cash_q,lots,rate,start,end,funding_stop,surcharge_until,hazard0_wad,hazard1_wad,load_wad):
    if end<start or min(hazard0_wad,hazard1_wad,load_wad)<0: raise ValueError('invalid tariff/interval')
    cuts=sorted({start,end,max(start,min(end,funding_stop)),max(start,min(end,surcharge_until))})
    total=F(0)
    for left,right in zip(cuts,cuts[1:]):
        cash=F(cash_q)-lots*rate*max(0,min(left,funding_stop)-start)
        slope=lots*rate if left<funding_stop else 0
        multiplier=4 if left<surcharge_until else 1
        for y,hazard in ((0,hazard0_wad),(1,hazard1_wad)):
            area=positive_integral(-cash-lots*U*y,slope,right-left)
            total+=area*F(hazard,Q)*F(Q+load_wad,Q)*multiplier/SECONDS_PER_DAY
    return total

def cumulative_charge(total,already_posted=0):
    rounded=-(-total.numerator//total.denominator)
    if rounded<already_posted: raise ValueError('cumulative premium cannot decrease')
    return rounded-already_posted
