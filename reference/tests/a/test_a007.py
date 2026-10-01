import unittest
from reference.a.premium_epochs import *
from reference.a.premium_integral import cumulative
from reference.common.units import Q
class EpochPremiumTests(unittest.TestCase):
    def test_no_intraperiod_compounding_or_touch_renewal(self):
        s=PremiumState(1,-100,0,100)
        self.assertEqual(principal(post(s,17)),principal(s))
        self.assertEqual(post(s,17).surcharge_until,100)
        changed=mutate(s,1,1,-101,50);self.assertEqual(changed.surcharge_until,21650)
        rolled=capitalize(post(s,17),2)
        self.assertEqual((rolled.paid,principal(rolled)),(0,-117))
        self.assertEqual(capitalize(rolled,2),rolled)
    def test_surcharge_fourfold_and_expiration(self):
        args=(-100,1,0,0,100,100)
        base=cumulative(*args,0,Q,0,0)
        self.assertEqual(cumulative(*args,100,Q,0,0),4*base)
        self.assertEqual(cumulative(*args,50,Q,0,0),base*5/2)
