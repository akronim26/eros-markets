import unittest
from reference.a.coverage import *
class CoverageTests(unittest.TestCase):
    def test_oversized_ask_and_exact_cancellation(self):
        self.assertEqual(deficits(Account(1000,0),Orders(ask_lots=2300,ask_value_q=2300*550*Q)),(0,35000*Q))
        orders=Orders(bid_lots=18,bid_value_q=(7*400+11*600-7*400)*Q)
        self.assertEqual(orders.bid_value_q,6600*Q)
    def test_both_sides_and_premium_preserve_slack(self):
        a=Account(1000,-100*Q);r=Account(-1000,2000000*Q)
        before=slacks(r,*deficits(a),budget=10*Q)
        after=slacks(Account(r.lots,r.cash_q+3*Q),*deficits(Account(a.lots,a.cash_q-3*Q)),budget=10*Q)
        self.assertTrue(all(y>=x for x,y in zip(before,after)))
        self.assertFalse(concentration_ok(201*Q,0,10000*Q))
