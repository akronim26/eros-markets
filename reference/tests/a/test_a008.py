import unittest
from reference.a.settlement import *
from reference.a.ledger import Account
class SettlementTests(unittest.TestCase):
    def test_payouts_and_fractional_escrow(self):
        a=Account(1000000,-480000000*Q);b=Account(-1000000,700000000*Q)
        self.assertEqual([payout(a,F(1,2)),payout(b,F(1,2))],[20000000,200000000])
        shares,treasury=allocation(100*Q,[10],Q//2,[Q//2],[1,2])
        self.assertEqual(sum(shares)*Q+treasury+11*Q,100*Q)
    def test_fragmented_fee_and_recovery(self):
        cap=fee_commitment(17*613*Q,10**15)
        self.assertEqual(sum(fee_fragment(cap,17,i,i+1) for i in range(17)),cap)
        self.assertEqual(recovery([3*Q,7*Q],5*Q),[1,3])
        self.assertEqual(recovery([],0),[])
        self.assertEqual(backstop(100,1000,50),20)
