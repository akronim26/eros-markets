"""Exact units and immutable inputs for risk economics v1.0 (A001).

This is the proposed G0 contract, not a stateful ledger or a pricing model.
Python integers deliberately widen intermediates; checked boundaries match Solidity.
"""

from dataclasses import dataclass
from enum import Enum
from fractions import Fraction

Q = WAD = 10**18
ATOMS_PER_USDC = 10**6
LOTS_PER_CLAIM = 1000
TICKS_PER_UNIT = 1000
WAD_PER_TICK = 10**15
PAYOFF_ATOMS_PER_LOT = 1000
PAYOFF_Q_PER_LOT = PAYOFF_ATOMS_PER_LOT * Q
MAX_POSITION_LOTS = 2**40
CASH_Q_BOUND = 2**180  # Exclusive, on either side of zero.
UINT64_MAX = 2**64 - 1
UINT256_MAX = 2**256 - 1
INT256_MIN = -(2**255)
INT256_MAX = 2**255 - 1
SECONDS_PER_DAY = 86400
REFERENCE_SEED = 0x45524F53
INTERFACE_VERSION = "risk-math-g0-draft-1"


class Side(Enum):
    BUY = 0
    SELL = 1


class FinalOutcome(Enum):
    UNSET = 0
    NO = 1
    YES = 2
    INVALID = 3


class OracleOutcome(Enum):
    """Source encoding; intentionally NOT interchangeable with FinalOutcome."""

    NONE = 0
    YES = 1
    NO = 2
    INVALID = 3


def checked_int(value: int, minimum: int, maximum: int, name: str) -> int:
    # Reject floats, bools and enums: each would otherwise obscure a boundary cast.
    if type(value) is not int:
        raise TypeError(f"{name} must be an integer")
    if not minimum <= value <= maximum:
        raise ValueError(f"{name} outside [{minimum}, {maximum}]")
    return value


def checked_position_lots(value: int) -> int:
    return checked_int(value, -MAX_POSITION_LOTS, MAX_POSITION_LOTS, "positionLots")


def checked_cash_q(value: int) -> int:
    return checked_int(value, -CASH_Q_BOUND + 1, CASH_Q_BOUND - 1, "cashQ")


def checked_price_wad(value: int, *, live: bool = False) -> int:
    return checked_int(value, 1 if live else 0, WAD - 1 if live else WAD, "priceWad")


def checked_tick(value: int) -> int:
    return checked_int(value, 1, 999, "tick")


def checked_uint64(value: int, name: str = "uint64", *, nonzero: bool = False) -> int:
    return checked_int(value, int(nonzero), UINT64_MAX, name)


def checked_q(value: int, name: str = "amountQ") -> int:
    return checked_int(value, 0, UINT256_MAX, name)


def next_version(value: int) -> int:
    return checked_uint64(checked_uint64(value) + 1, "nextVersion", nonzero=True)


def floor_div(numerator: int, denominator: int) -> int:
    """Mathematical floor, including negative numerator or denominator."""
    if type(numerator) is not int or type(denominator) is not int:
        raise TypeError("division operands must be integers")
    if denominator == 0:
        raise ZeroDivisionError("zero denominator")
    return numerator // denominator


def ceil_div(numerator: int, denominator: int) -> int:
    """Mathematical ceiling; never Solidity's signed truncation toward zero."""
    if type(numerator) is not int:
        raise TypeError("division operands must be integers")
    return -floor_div(-numerator, denominator)


def atoms_to_q(atoms: int) -> int:
    """Unsigned unit conversion; callers must also check resulting account cash."""
    checked_int(atoms, 0, UINT256_MAX // Q, "atoms")
    return atoms * Q


def q_to_atoms_down(amount_q: int) -> int:
    return checked_q(amount_q) // Q


def claims_to_lots(claims: Fraction | int) -> int:
    if type(claims) not in (int, Fraction):
        raise TypeError("claims must be exact (integer or Fraction)")
    lots = claims * LOTS_PER_CLAIM
    if isinstance(lots, Fraction):
        if lots.denominator != 1:
            raise ValueError("claims are not an integral lot quantity")
        lots = lots.numerator
    return checked_position_lots(lots)


def tick_to_wad(tick: int) -> int:
    return checked_tick(tick) * WAD_PER_TICK


def fill_value_q(lots: int, tick: int) -> int:
    """Dimension conversion only: an unsigned fill notional, with no posting."""
    return checked_uint64(lots, "lots", nonzero=True) * checked_tick(tick) * Q


def position_value_q(position_lots: int, price_wad: int) -> int:
    """Already Q: DO NOT divide 1000 * lots * priceWad by WAD."""
    return checked_position_lots(position_lots) * 1000 * checked_price_wad(price_wad)


def from_binary_y(y: int) -> FinalOutcome:
    checked_int(y, 0, 1, "binary Y")
    return FinalOutcome.YES if y == 1 else FinalOutcome.NO


def from_oracle_outcome(outcome: OracleOutcome) -> FinalOutcome:
    if type(outcome) is not OracleOutcome:
        raise TypeError("explicit OracleOutcome required")
    if outcome is OracleOutcome.NONE:
        raise ValueError("oracle outcome is not final")
    return {
        OracleOutcome.YES: FinalOutcome.YES,
        OracleOutcome.NO: FinalOutcome.NO,
        OracleOutcome.INVALID: FinalOutcome.INVALID,
    }[outcome]


@dataclass(frozen=True)
class AccountInput:
    position_lots: int
    cash_q: int
    funding_checkpoint_q_per_lot: int = 0
    order_epoch: int = 0
    position_version: int = 0

    def __post_init__(self) -> None:
        checked_position_lots(self.position_lots)
        checked_cash_q(self.cash_q)
        checked_int(self.funding_checkpoint_q_per_lot, INT256_MIN, INT256_MAX, "fundingCheckpointQPerLot")
        checked_uint64(self.order_epoch, "orderEpoch")
        checked_uint64(self.position_version, "positionVersion")


@dataclass(frozen=True)
class OrderInput:
    side: Side
    limit_tick: int
    remaining_lots: int
    remaining_fee_cap_q: int = 0
    market_order_epoch: int = 0
    account_order_epoch: int = 0
    reduce_only: bool = False
    position_version: int = 0

    def __post_init__(self) -> None:
        if type(self.side) is not Side or type(self.reduce_only) is not bool:
            raise TypeError("explicit Side and boolean reduceOnly required")
        checked_tick(self.limit_tick)
        checked_uint64(self.remaining_lots, "remainingLots", nonzero=True)
        checked_q(self.remaining_fee_cap_q, "remainingFeeCapQ")
        checked_uint64(self.market_order_epoch, "marketOrderEpoch")
        checked_uint64(self.account_order_epoch, "accountOrderEpoch")
        checked_uint64(self.position_version, "positionVersion")


@dataclass(frozen=True)
class FundingInput:
    epoch_id: int
    epoch_start: int
    epoch_end: int
    last_accrued_at: int
    effective_stop_at: int
    funding_f_q_per_lot: int
    rate_q_per_lot_sec: int
    oi_all_lots: int
    reserve_position_lots: int
    remaining_budget_q: int

    def __post_init__(self) -> None:
        checked_uint64(self.epoch_id, "epochId", nonzero=True)
        for name in ("epoch_start", "epoch_end", "last_accrued_at", "effective_stop_at"):
            checked_uint64(getattr(self, name), name)
        if not self.epoch_start <= self.last_accrued_at <= self.effective_stop_at <= self.epoch_end:
            raise ValueError("funding times must be ordered within one epoch")
        if self.epoch_start == self.epoch_end:
            raise ValueError("empty funding epoch")
        checked_int(self.funding_f_q_per_lot, INT256_MIN, INT256_MAX, "fundingFQPerLot")
        checked_int(self.rate_q_per_lot_sec, INT256_MIN, INT256_MAX, "rateQPerLotSec")
        checked_q(self.oi_all_lots, "oiAllLots")
        checked_position_lots(self.reserve_position_lots)
        if abs(self.reserve_position_lots) > self.oi_all_lots:
            raise ValueError("one-sided OI must include reserve position")
        checked_q(self.remaining_budget_q, "remainingBudgetQ")


@dataclass(frozen=True)
class PayoffInput:
    position_lots: int
    cash_q_at_halt: int
    final_outcome: FinalOutcome
    settlement_price_wad: int

    def __post_init__(self) -> None:
        checked_position_lots(self.position_lots)
        checked_cash_q(self.cash_q_at_halt)
        checked_price_wad(self.settlement_price_wad)
        if type(self.final_outcome) is not FinalOutcome:
            raise TypeError("explicit FinalOutcome required")
        if self.final_outcome is FinalOutcome.UNSET:
            raise ValueError("finality is required")
        if self.final_outcome is FinalOutcome.NO and self.settlement_price_wad != 0:
            raise ValueError("NO requires price zero")
        if self.final_outcome is FinalOutcome.YES and self.settlement_price_wad != WAD:
            raise ValueError("YES requires price WAD")
