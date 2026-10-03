# Block 4 — Validation pipeline (O39)

Plan §10, §14.3, §13 row O39. Format and rules: header of `docs_oracle/check_tasks.py`. Python 3.12
in `oracle/validation/`; `fractions.Fraction` for the gate maths, no floats in any gate decision.
Runs in parallel with everything else and gates only the Layer 2 auto path (L2_AUTO); launch works
without it because every Layer 2 result is reviewed.

## O39 · Validation pipeline
Plan §13: owner OA · 6+ PD · depends — · acceptance: report + `setCategory` proposals.

### O39.1 · Dataset
- Owner: OA
- PD: 1
- Depends: -
- Plan: §10
- Cut: no
- Status: todo
- Files: oracle/validation/dataset/*, oracle/validation/tests/test_dataset.py
- Build: Resolved Polymarket and Kalshi markets with their official resolution, grouped by parent market, labelled by category (sports, macro releases, elections, crypto, companies, …). Store raw pulls with their hashes.
- Done when: tests check that every row has a parent and a category and that parent counts are reported per category.
- Check: cd oracle/validation && python3 -m unittest tests/test_dataset.py

### O39.2 · Frozen holdout split
- Owner: OA
- PD: 0.5
- Depends: O39.1
- Plan: §10
- Cut: no
- Status: todo
- Files: oracle/validation/split/*, oracle/validation/tests/test_split.py
- Build: Split by parent (never by row) into train, calibration and holdout before any tuning; record the split and data hashes.
- Done when: tests show no parent appears in two splits and the recorded hashes reproduce.
- Check: cd oracle/validation && python3 -m unittest tests/test_split.py

### O39.3 · Freeze the gate
- Owner: OA
- PD: 1
- Depends: O39.2
- Plan: §10, §8.3
- Cut: no
- Status: todo
- Files: oracle/validation/gate/*, oracle/validation/tests/test_gate.py
- Build: Choose the three models (low error correlation, not only accuracy), the prompt per category and θ_hi on train and calibration only; record `modelIdHashes`, `promptHash` and `gateHash = keccak256(abi.encode(modelIdHashes, promptHash, calibratorHash, highConfBps))` once O39.4 fixes `calibratorHash`.
- Done when: the gate file is committed and nothing in it was derived from the holdout.
- Check: cd oracle/validation && python3 -m unittest tests/test_gate.py

### O39.4 · Calibration maps
- Owner: OA
- PD: 1
- Depends: O39.3
- Plan: §10, §8.3
- Cut: no
- Status: todo
- Files: oracle/validation/calibration/*.json, oracle/validation/tests/test_calibration.py
- Build: Isotonic regression per model grouped by parent; clip to [0.01, 0.99]; publish JSON breakpoint maps and `calibratorHash = keccak256(JCS(all three maps))` (the panel runner reads the same files, O33.3).
- Done when: tests check monotone maps, clipping and that the hash matches the panel runner's computation.
- Check: cd oracle/validation && python3 -m unittest tests/test_calibration.py

### O39.5 · Holdout measurement
- Owner: OA
- PD: 1.5
- Depends: O39.4
- Plan: §10, §14.3
- Cut: no
- Status: todo
- Files: oracle/validation/measure/*, oracle/validation/tests/test_measure.py
- Build: Per category, in the bucket "unanimous YES/NO with every ĉ ≥ θ_hi": k errors over N unique parents; `U95 = BetaInv(0.95; k+1, N−k)` (Clopper–Pearson) computed exactly by bisection on the rational binomial tail, rounded up; error correlation `ρ_ij`; watchdog miss rate `f` on the panel's own errors.
- Done when: tests reproduce `1 − 0.05^(1/N)` at k = 0: 1.98% at N = 150, 1.99% at N = 149, 0.99% at N = 300.
- Check: cd oracle/validation && python3 -m unittest tests/test_measure.py

### O39.6 · Report, review limit and governance proposals
- Owner: OA
- PD: 1
- Depends: O39.5
- Plan: §10, §14.3
- Cut: no
- Status: todo
- Files: oracle/validation/report/*, docs_oracle/validation-report.md
- Build: Publish the report with data hashes and the code commit; compute `OI_review = c_r / (Δp − r·T_r)` from the measured U95; prepare `setCategory(categoryId, gateHash, u95Bps, N, true)` Timelock operations only for categories with `U95 ≤ 2%` and `N ≥ 150`.
- Done when: the report is committed and every proposed category meets both thresholds.
- Check: manual: docs_oracle/validation-report.md committed with data hashes, commit and the Timelock operation IDs
