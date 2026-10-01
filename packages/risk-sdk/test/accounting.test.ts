import { AccountingReplay, Q, markedEquityQ, unsignedAtoms } from "../src/accounting";
function assert(condition: boolean): void { if (!condition) throw new Error("accounting assertion"); }
const a = { positionLots: 17n, cashQ: 0n, fundingCheckpointQ: 0n };
assert(markedEquityQ(a, 613n * 10n ** 15n) === 10421n * Q);
assert(unsignedAtoms(Q / 2n).atoms === 0n);
assert(unsignedAtoms(Q / 2n).residualQ === Q / 2n);
const replay = new AccountingReplay();
replay.apply({ name: "AccountBalance", owner: "0x01", value: { ...a, cashQ: -10421n * Q } });
replay.apply({ name: "MarketBalance", value: { allocationQ: 100n * Q, reserveLots: -17n,
  reserveCashQ: 10521n * Q, protocolFeeQ: 0n, keeperPayableQ: 0n, fundingClearingQ: 0n,
  fundingCushionQ: 0n, fundingBudgetQ: 0n, oiAllLots: 17n } });
assert(replay.reconcileLive().cashDifferenceQ === 0n);
assert(replay.reconcileLive().netPositionLots === 0n);
