import unittest
from reference.a.integer_bounds import *
class NumericTests(unittest.TestCase):
    def test_wide_products_and_signed_overflow(self):
        self.assertEqual(mul_div(2**200,2**100,2**100),2**200)
        self.assertEqual((signed_div(-7,3),signed_div(-7,3,True)),(-3,-2))
        with self.assertRaises(OverflowError):signed_div(INT256_MIN,-1)
        with self.assertRaises(OverflowError):mul_div(UINT256_MAX,UINT256_MAX,1)
    def test_sqrt_brackets_at_integer_edges(self):
        for x in [0,1,2,3,4,2**128-1,UINT256_MAX]:
            r=sqrt_up(x);self.assertGreaterEqual(r*r,x)
            if r:self.assertLess((r-1)*(r-1),x)
