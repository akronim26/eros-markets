from math import isqrt
from reference.common.units import UINT256_MAX, INT256_MAX, INT256_MIN, floor_div, ceil_div

def mul_div(x,y,d,up=False):
    if not all(type(v)is int and 0<=v<=UINT256_MAX for v in (x,y,d)) or d==0:raise ValueError('domain')
    result=ceil_div(x*y,d) if up else x*y//d
    if result>UINT256_MAX:raise OverflowError('quotient')
    return result

def sqrt_up(x):
    if not 0<=x<=UINT256_MAX:raise ValueError('domain')
    root=isqrt(x)
    return root+(root*root<x)

def signed_div(a,b,up=False):
    if not INT256_MIN<=a<=INT256_MAX or not INT256_MIN<=b<=INT256_MAX:raise ValueError('domain')
    result=ceil_div(a,b) if up else floor_div(a,b)
    if not INT256_MIN<=result<=INT256_MAX:raise OverflowError('quotient')
    return result
