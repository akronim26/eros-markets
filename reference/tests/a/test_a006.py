import unittest
from fractions import Fraction as F
from reference.a.premium_integral import *
class PremiumTests(unittest.TestCase):
    def test_triangles_and_neutral_touch(self):
        self.assertEqual(positive_integral(-10,1,20),50)
        self.assertEqual(positive_integral(10,-1,20),50)
        area=positive_integral(100,F(10,3600),3600)*F(2,10000)/86400
        self.assertEqual(area,F(7,8000))
        values=[area*10**6*Q*F(i*i,100) for i in range(11)]
        paid=0
        for x in values:paid+=cumulative_charge(x,paid)
        self.assertEqual(paid,cumulative_charge(values[-1]))
    def test_funding_stop_is_exact_split(self):
        actual=cumulative(-100,1,1,0,20,10,0,Q,0,0)
        self.assertEqual(actual,F(105*10+110*10,86400))
