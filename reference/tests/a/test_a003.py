import unittest
from fractions import Fraction as F
from reference.a.ledger import Account,fill,equity,takeover
from reference.common.units import Q
class LedgerTests(unittest.TestCase):
    def test_bilateral_fixture_and_all_payoffs(self):
        b,s,fees=fill(Account(0,120_000_000*Q),Account(0,100_000_000*Q),1_000_000,600)
        self.assertEqual((b.cash_q,s.cash_q,fees),(-480_000_000*Q,700_000_000*Q,0))
        for p in (F(0),F(1,2),F(1)):
            self.assertEqual(equity(b,p)+equity(s,p),220_000_000*Q)
        self.assertEqual(b.lots+s.lots,0)
    def test_fee_and_takeover_conservation(self):
        b,s,fees=fill(Account(0,100000*Q),Account(0,100000*Q),17,613,3,7)
        self.assertEqual(b.cash_q+s.cash_q+fees,200000*Q)
        zero,reserve=takeover(b,Account())
        self.assertEqual((zero.lots,zero.cash_q),(0,0));self.assertEqual(reserve,b)
