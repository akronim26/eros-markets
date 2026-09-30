# Person B progress (resume point for a new session)

Branch `feat/risk`. Solo mode (see `B-assumptions.md` P-1). Status words:

- `lane-pass (stand-ins)`: the task's exact acceptance command ran on the committed tree and
  exited 0, using B stand-ins/mocks for A or counterparts. Not `accepted`: no gate is recorded.
- `lane-pass (pure)`: exit 0 with no stand-in involved.
- `needs-merge`: the command cannot run as written until A's files exist; a stand-in command ran.
- `blocked`: cannot be completed on this branch; reason given.

Evidence: `docs/merge/B-evidence/<TASK>.json` (command, exit code, commit, output tail).

| Task | Status | Task commit | Acceptance command exit | Notes |
|---|---|---|---|---|
| B001 | lane-pass (pure) | 2f94023 | 0 | 31 function contracts, ownership map (240 files, no duplicate writer), counterpart doc |
| B002 | lane-pass (pure) | 1e21057 | 0 | 20 golden cases re-derived by hand in the test |
| B003 | lane-pass (pure) | 41106fc | 0 | exact horizon, directed sqrt, step-up envelope; nonmonotone bins rejected; running-max conversion |
| B004 | lane-pass (pure) | 331b7bb | 0 | linear hazard bound, eps', k interval, adverse drift >= source drift |
| B005 | lane-pass (pure) | d040ae3 | 0 | long IM 120, short IM 95.8937, 80 fails/100 passes, missing calibration 1x, monotone proof + grids |
| B006 | lane-pass (scripted A coverage port) | 789ed4d | 0 | Emin lower bound, reach envelope, halving cap; enumeration of fill mixtures; hump + sign flip; coverage via scripted port (S-1) |
| B007 | lane-pass (pure) | 790d444 | 0 | validity-weighted TWAP, 30s carry, same-second dedupe, basis, median+band clamp, trunc0 funding rate, movement trigger |
| B008 | lane-pass (pure) | 4a0e32e | 0 | eligibility/takeover split (no budget input), x-free estimate, fee-aware bankruptcy tick, fee waiver, pacing, NEEDS_MORE_WORK |
| B009 | lane-pass (pure) | bf0b821 | 0 | stage precedence, cutoffs (halt/roll order equal), nonrenewable grace, bootstrap, INVALID readiness, finality |
| B010 | lane-pass (stand-in QMath/MathTypes) | ca9b5c0 | 0 | bounds >= reference brackets (T-1), eps/T/max-size edges, fuzz monotone; uses provisional QMath (S-2) |
| B011 | lane-pass (stand-in QMath/MathTypes) | 5106ddd | 0 | B005 vectors within T-1; long IM 120 exact; short 80/100; 1x exact endpoints; wad-second horizon (M-8) |
| B010 | lane-pass (stand-in QMath/MathTypes) | b1936e7 | 0 | rerun after M-8 wad-second horizon; test arithmetic fix |
| B012 | lane-pass (stand-in QMath/MathTypes; scripted A coverage fn) | f8f02e1 | 0 | Emin, reach envelope, <=64 halvings via coverage fn pointer; enumeration of admitted states; direct 5x; side flip; stale extrema |
| B013 | lane-pass (stand-in QMath) | 8afb4d7 | 0 | array + cumulative TWAP (fuzz-equal), same-second dedupe, gaps, all median orderings, band, trunc0 rate, movement |
| B014 | lane-pass (stand-in QMath/MathTypes) | 23956bc | 0 | takeover has no work input; estimate 522929-30 vs ref 522929; bankruptcy/fee waiver; stage boundaries; early INVALID; finality |
| B015 | lane-pass (stand-in QMath/MathTypes; scripted coverage in admission vectors) | d28cc5f | 0 | generated reference vectors (seed 20261001): 92 margin, 40 tail, 40 twap, 30 estimate, 30 bankruptcy, 60 stage, 81 admission; mutation check caught |
| B016 | lane-pass (no A stand-in; CP-PRICE mocked by test signer) | a6243e1 | 0 | domain/signer/source/rules checks, strict sequence, observedAt order, future tolerance 0, delayed keeps observedAt; CP-PRICE live join BLOCKED |
| B017 | lane-pass (no A stand-in) | 29a9b45 | 0 | INDEX/PERP/BASIS rings (1024, same-second replace, log-time queries); O(1) INVALID start/end checkpoints survive ring wrap |
| B018 | lane-pass (epoch-opening hook called by test, A stand-in S-4) | 22bb490 | 0 | RiskContext (no cash/OI), bootstrap backed-only in index band, NORMAL only at epoch opening with all windows, halt overrides |
| B019 | lane-pass (CP-ORACLE/CP-FACTORY/CP-BOOK interfaces only; live joins BLOCKED) | 9fca84f | 0 | listing validation + one-time init, role checks, versioned calibration, oracle enum map YES1->settle(1)->YES2 / NO2->settle(0)->NO1, release decision port, ABI selectors |
| B020 | lane-pass (doubles are the subject; A port is stand-in S-5) | 93cd076 | 0 | MockAccountingPort (sequencing reverts, call log, scripted coverage), MockBookAdapter (spec 7.7 loop, bounded steps, no filled unrest), MockResolutionAuthority (mapping, delayed retry), RiskHarness |
