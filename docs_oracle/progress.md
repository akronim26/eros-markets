# Oracle progress

Append one row when a task in `tasks/*.md` is set to `done`. Never edit or delete a row; a fix is a
new row. `check_tasks.py` fails when a `done` task has no row here.

| Date (UTC) | Task | Commit | Check exit | Notes |
| --- | --- | --- | --- | --- |
| 2026-10-02 | O00.1 | (this commit) | 0 | Foundry 1.8.3 (cae51ad); four submodules at the §12.2a commits; `forge config` clean for default and ci |
| 2026-10-02 | O00.2 | (this commit) | 0 | solc 0.8.16 + 0.8.30 via auto-detect; UMA OOv3 13,579 B runtime; 2/2 smoke tests pass; `./out` read permission added (ADJ-28) |
| 2026-10-02 | O00.3 | (this commit) | 0 | bun 1.3.13 workspace (packages/*, services/*); no lockfile until the first member (O20.1); ADJ-10 confirmed in a scratch copy |
| 2026-10-02 | O00.4 | d5c03bd | 0 | oracle CI forge job green: run https://github.com/xipharis/eros-markets/actions/runs/36948818794 (fmt, build --sizes, 2/2 tests, profile ci); contracts.yml unchanged |
| 2026-10-02 | O01.1 | (this commit) | manual | seam request S-01–S-15 drafted with engine source citations; to be sent to Person A, Person B and the factory owner |
| 2026-10-02 | O01.1 | (this commit) | manual | reworked for the hackathon: seam request removed, oracle team decides S-01–S-15 in seam-decisions.md (ADJ-29) |
| 2026-10-02 | O01.2 | (this commit) | 0 | decisions applied: OG0 criteria, TestUSDC in O19.3/X03, DEP-3/DEP-4, ADJ-24/25; validator passes |
| 2026-10-02 | O02.1 | (this commit) | 0 | C.2–C.6 and B.7 copied byte for byte from the plan (10 files); fmt clean; build ok; ci profile tests 2/2 |
| 2026-10-02 | O02.2 | (this commit) | 0 | 10/10 constants and C.7 vector tests; digests/specHash/topic also matched with viem 2.57.2; 11 interface ABIs + SHA256SUMS; ./vectors read permission (ADJ-28) |
| 2026-10-02 | O10.1 | (this commit) | 0 | HostLib: 26 tests incl. 2 fuzz (accept path reached in ~25% of fuzz inputs); ci profile 10,000 runs |
| 2026-10-02 | O10.2 | (this commit) | 0 | FeedSpecLib: 71 hand-coded validation vectors + 5 viem specHash vectors (B.3 = C.7) all pass; mutation of one expected code caught |
| 2026-10-02 | O10.3 | (this commit) | 0 | ClaimRenderer: 15 tests; default template equals independently built text; exact worst-case bound at maximum inputs (mutation caught); fuzz 1,000 / ci 10,000 runs |
| 2026-10-02 | O10.4 | (this commit) | 0 | VoidBound + BondMath: 14 tests; C.7 vectors (3,837,600 s; 6,000 s; 222,400,000 atoms) from vectors/; fuzz ceil and monotonicity; two mutations caught |
| 2026-10-02 | O10.5 | (this commit) | 0 | SigLib: 23 tests; P1/R1 digests = C.7; panel 65-byte/v/low-s rules; 11 m-of-k cases incl. ERC-1271 accept/refuse; three mutations caught |
| 2026-10-02 | O00.2 | (this commit) | 0 | cleanup: removed Toolchain.t.sol and 7 duplicate vector assertions (Constants x5, SigLib x1, FeedSpecLib x1); 85 tests remain, each C.7 value asserted once through its library |
| 2026-10-02 | O10.2 | (this commit) | 0 | specHash vectors moved from feedspec.json to spechash.json (one home per vector, plan §6.1 layout); test now requires all 5 |
| 2026-10-02 | O19.1 | (this commit) | 0 | ResolutionEngineStub + StubMarketFactory: 24 tests covering every non-accounting case of counterpart-oracle-fixtures.json; error selectors equal the real engine's |
| 2026-10-02 | O11.1 | (this commit) | 0 | MockResolutionEngine, MockMarketFactory, MockAssertionVenue, MockOracleView, MockBondTreasury: 12 smoke tests, one per knob |
| 2026-10-02 | O11.2 | (this commit) | 0 | MarketRegistry storage, versioned globals (every §14.4 bound on both sides, chainId 143 and 10143; BadGlobals codes per ADJ-30), governance setters, SSTORE2 text helpers: 47 tests; 35/35 mutations caught; ci suite 168/168 |
| 2026-10-02 | O11.3 | (this commit) | 0 | createMarket rules 1-6 with exact C.4 codes (BadTimes 1-6, BadFeed 1-13, BadAllowList 1-3, BadAIConfig 1-5, BadUMAConfig 1-6, identity and groups behind the cut switch): 48 tests; 41/41 mutations caught; ci suite 216/216 |
| 2026-10-02 | O11.4 | (this commit) | 0 | createMarket steps 7-9 and every C.4 market view; registry now `is IMarketRegistry`; 17 tests incl. the real StubMarketFactory path; 40/40 mutations caught; ci suite 233/233 |
| 2026-10-02 | O12.1 | (this commit) | 0 | BondTreasury ledgers, deposit (credits what arrived), listing commitments, release (no-op when none open), withdraw and limits: 20 tests incl. isolation fuzz (10,000 runs ci); 20/20 mutations caught; ci suite 253/253 |
| 2026-10-02 | O12.2 | (this commit) | 0 | BondTreasury bond flows (fund, returned, lost, stuck; per-market cap; per-attempt keys, ADJ-27) and proposer rewards (push with IOU fallback, never reverts; all-or-nothing claimOwed): 22 tests incl. never-revert fuzz (10,000 runs ci); 24/24 mutations caught; ci suite 275/275 |
| 2026-10-02 | O12.3 | (this commit) | 0 | BondTreasury watchdog disputes (venue bond, liveness pre-check, cap), closeDispute (venue settled or VOID_DEADLINE write-off, once) and conservative skim; treasury now `is IBondTreasury`: 24 tests incl. skim fuzz (10,000 runs ci); 27/28 mutations caught (1 equivalent); ci suite 299/299 |
| 2026-10-02 | O13.1 | (this commit) | 0 | UmaAdapter and ErosSandboxOracle from B.4/B.5 verbatim plus the C.1 lint suppression; sandbox: 13 tests (owner-only answer, once per request, non-requester ignored, one-shot setRequester, ownership hand-off); 12/12 mutations caught |
| 2026-10-02 | O13.2 | (this commit) | 0 | B.8 real-UMA suite ported verbatim to test/integration-uma (imports per ADJ-05): 6/6 A2 cases against real OOv3; 10/14 adapter mutations caught here, the other 4 are O13.3 cases |
| 2026-10-02 | O13.3 | (this commit) | 0 | Extended real-UMA cases: permissionless asserter, separate payer/asserter/disputer roles, treasury disputeFor win and loss, settled directly on OOv3, never-answered dispute (settleAssertion reverts, trySettle false), final fee reaching minimumBond only after syncUmaParams: 12 tests; 21/23 adapter mutations caught (2 equivalent) |
