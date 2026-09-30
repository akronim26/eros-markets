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
