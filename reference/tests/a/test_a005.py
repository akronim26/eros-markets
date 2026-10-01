import unittest
from reference.a.funding import *
class FundingTests(unittest.TestCase):
    def test_reserve_payer_and_receiver_clear(self):
        for rate,reserve in ((1,40),(-1,40),(1,-40),(1,0)):
            e=open_epoch(0,100,rate,100,10000)
            e,rp=advance(e,1,30,100,100,reserve)
            longs=100-max(reserve,0);shorts=-100-min(reserve,0)
            self.assertEqual(e.cushion,100-max(rp,0))
            e,_,_=sync(e,longs,0,0);e,_,_=sync(e,shorts,0,0)
            self.assertEqual((e.clearing,e.cushion),(0,0))
    def test_oi_change_and_permanent_stop(self):
        e=open_epoch(0,1000,1,100,10000)
        e,_=advance(e,20,1000,1000,100,0)
        e,_=advance(e,100,1000,1000,200,0)
        self.assertEqual((e.last,e.budget,e.stopped),(60,0,True))
        self.assertEqual(advance(e,200,1000,1000,200,0)[0],e)
    def test_zero_oi_and_stale_gap_never_catch_up(self):
        e=open_epoch(0,3600,1,0,100000);self.assertTrue(e.stopped)
        e=open_epoch(0,3600,1,1,100000)
        e,_=advance(e,31,30,3600,1,0)
        self.assertEqual((e.last,e.stopped),(30,True))
        self.assertEqual(advance(e,60,90,3600,1,0)[0],e)
