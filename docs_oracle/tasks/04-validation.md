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
- Status: done
- Files: oracle/validation/dataset/*, oracle/validation/tests/test_dataset.py
- Build: Resolved Polymarket and Kalshi markets with their official resolution, grouped by parent market, labelled by category (sports, macro releases, elections, crypto, companies, …). Store raw pulls with their hashes.
- Done when: tests check that every row has a parent and a category and that parent counts are reported per category.
- Check: cd oracle/validation && python3 -m unittest tests/test_dataset.py
- Notes: `dataset/pull.py` pulls closed Polymarket events (Gamma API, by tag in precedence order: elections, economy, Fed, earnings, business, crypto, sports, politics; recurring tag 101757 excluded; up to 600 events per pull) and settled Kalshi markets (v2, `mve_filter=exclude`, 40 cursor pages, categories from `/series/{ticker}`) for 2025-10-01 to 2026-10-01 into `raw/` (each response gzipped with its URL, fetch time and sha256 in a sidecar; resumable, a failing page is skipped and recorded, a category stops after 3 failures in a row); `MANIFEST.json` lists 378 files and 3 failures (Polymarket Crypto offsets 300-500 answer HTTP 500, also on retry). `dataset/build.py` checks every hash and writes one row per resolved binary market (outcome YES, NO or INVALID from the official resolution; 680 unclosed Polymarket and 57 scalar Kalshi markets excluded and counted) grouped by parent event and labelled with one of seven categories: 63,951 rows, 5,462 parents (sports 1,394, crypto 922, macro 860, companies 707, elections 608, other 493, politics 478). Storage per ADJ-39: `raw/` (as a byte-reproducible `raw.tar.gz`, sha256 4c4b518c…) and `rows.jsonl.gz` stay local and git-ignored; the repository holds MANIFEST.json, snapshot.json and report.json (rows sha256 ee3feffc…), and a rebuild reproduces the rows byte for byte. 18 tests: fixture build (outcomes, exclusions, grouping), resumable pull, snapshot pack/unpack and tamper checks, the public pins agreeing with each other, and on the real dataset every row has a parent and a category, one category per parent, unique market ids, parent counts per category equal the report, rows point at manifest files and match the pinned hash (these skip where the dataset is absent). `validation` CI job added (ADJ-11).

### O39.2 · Frozen holdout split
- Owner: OA
- PD: 0.5
- Depends: O39.1
- Plan: §10
- Cut: no
- Status: done
- Files: oracle/validation/split/*, oracle/validation/tests/test_split.py
- Build: Split by parent (never by row) into train, calibration and holdout before any tuning; record the split and data hashes.
- Done when: tests show no parent appears in two splits and the recorded hashes reproduce.
- Check: cd oracle/validation && python3 -m unittest tests/test_split.py
- Notes: `split/split.py` assigns each parent from its id alone: `u = int(sha256("eros-validation-split/1:" + parent_id)[:16 hex]) / 2^64` as an exact Fraction, train below 3/10, calibration below 1/2, holdout the rest (half the parents, because the gate needs ≥ 150 parents per category in its bucket). Frozen 4 Oct 2026 before any tuning on rows sha256 ee3feffc…: train 1,671 parents, calibration 1,076, holdout 2,715; every category in every split (holdout: sports 670, crypto 463, macro 423, companies 350, elections 297, other 269, politics 243). `split/split.json` records the rule, the rows hash and, per split, parent and row counts per category and the sha256 of its sorted parent ids (no ids published, ADJ-39). 10 tests: the rule recomputed independently, half-open bounds, whole parents and counts on fixture rows; on the real rows no parent in two splits and split.json reproduces exactly (these skip in CI); the pins add up to report.json. CI now runs every validation test file.

### O39.3 · Freeze the gate
- Owner: OA
- PD: 1
- Depends: O39.2
- Plan: §10, §8.3, ADJ-46
- Cut: no
- Status: done
- Files: oracle/validation/gate/*, oracle/validation/tests/test_gate.py
- Build: Choose the three models (low error correlation, not only accuracy), the prompt per category and θ_hi on train and calibration only; record `modelIdHashes`, `promptHash` and `gateHash = keccak256(abi.encode(modelIdHashes, promptHash, calibratorHash, highConfBps))` once O39.4 fixes `calibratorHash`.
- Done when: the gate file is committed and nothing in it was derived from the holdout.
- Check: cd oracle/validation && python3 -m unittest tests/test_gate.py
- Notes: Pilot per ADJ-46. `gate/sample.py` picks, per split, 2 train / 3 calibration / 3 holdout parents of macro and elections (the categories whose rules cite the most fetchable pages) in a hash-fixed order with spares, one market per parent; the panel runner's `bun run validate` snapshots the cited pages (O32), skips a market with no fetchable allow-listed page without a model call, asks the three panel models with the pinned prompt, and stops at ₹18 (spent ₹8.93: 27 sampled, 16 put to the panel). Gemini 3.8 Flash now goes through AICredits (`aicredits` provider in oracle-sdk, key CREDITED_API_KEY). `gate/gate.py` freezes from train and calibration only: the three models with coverage, accuracy and pairwise error correlation (no alternative candidates in the pilot), the seven pinned prompts (promptHash), θ_hi by rule (smallest error-free non-empty train bucket on 9,000…9,900 bps, else 9,900: here 9,900), calibratorHash from O39.4 and gateHash per category as MarketRegistry encodes it. Committed: gate/gate.json, gate/panel-runs.json (labels and confidences, no page text), pinned by sha256. Pure-Python keccak256 (gate/keccak.py). 8 tests: keccak vectors (viem), modelIdHash and promptHash equal the panel runner's (bun), gateHash equals `cast` encoding, the θ rule, gate.json reproduces, and changing every holdout answer leaves it unchanged.

### O39.4 · Calibration maps
- Owner: OA
- PD: 1
- Depends: O39.3
- Plan: §10, §8.3, ADJ-46
- Cut: no
- Status: done
- Files: oracle/validation/calibration/*.json, oracle/validation/tests/test_calibration.py
- Build: Isotonic regression per model grouped by parent; clip to [0.01, 0.99]; publish JSON breakpoint maps and `calibratorHash = keccak256(JCS(all three maps))` (the panel runner reads the same files, O33.3).
- Done when: tests check monotone maps, clipping and that the hash matches the panel runner's computation.
- Check: cd oracle/validation && python3 -m unittest tests/test_calibration.py
- Notes: `gate/calibrate.py`: isotonic (pool-adjacent-violators) per model on the calibration split's known answers, every parent weighing 1, breakpoints at each block's ends, values rounded down to 4 decimals and clipped to [0.01, 0.99]; a model with known answers on fewer than 30 parents keeps the 0.49 placeholder (O33.3). In the pilot every model answered almost only NOT_YET (1 known answer in calibration), so calibration/maps.json holds three placeholder maps, calibratorHash 0x3f6d1e70…. calibratorHash = keccak256(JCS(maps)) with exact decimal tokens, no floats. 7 tests: monotone, pooled, clipped, rounded down, grouped by parent, exact calibrated bps, the hash equal to a panel-runner vector and to the panel runner's hash of the committed maps.json (bun).

### O39.5 · Holdout measurement
- Owner: OA
- PD: 1.5
- Depends: O39.4
- Plan: §10, §14.3, ADJ-46
- Cut: no
- Status: done
- Files: oracle/validation/measure/*, oracle/validation/tests/test_measure.py
- Build: Per category, in the bucket "unanimous YES/NO with every ĉ ≥ θ_hi": k errors over N unique parents; `U95 = BetaInv(0.95; k+1, N−k)` (Clopper–Pearson) computed exactly by bisection on the rational binomial tail, rounded up; error correlation `ρ_ij`; watchdog miss rate `f` on the panel's own errors.
- Done when: tests reproduce `1 − 0.05^(1/N)` at k = 0: 1.98% at N = 150, 1.99% at N = 149, 0.99% at N = 300.
- Check: cd oracle/validation && python3 -m unittest tests/test_measure.py
- Notes: `measure/bound.py`: U95 = BetaInv(0.95; k+1, N−k) as the smallest basis point b with the exact rational binomial tail F(b/10⁴) ≤ 1/20, found by bisection over b (rounded up, no float); N = 0 gives 100%. `measure/measure.py`: per category the holdout bucket (unanimous YES/NO, every calibrated bps ≥ θ_hi), N unique parents, k parents with an error, U95; φ between models; watchdog miss rate f on the panel's holdout errors (asked in the run when the majority is wrong). Pilot: every bucket empty (N = 0, U95 100%), no panel error so f undefined. 9 tests: 1.98% (N 150, 198 bps), 1.99% (N 149, 200 bps), 0.99% (N 300, 100 bps); (1 − b/10⁴)^N against 1/20 for 11 values of N; 1/300, 3/100, 5/20 against BetaInv computed separately by integrating the Beta density; bucket, parent and error counting; f; measure.json reproduces.

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
