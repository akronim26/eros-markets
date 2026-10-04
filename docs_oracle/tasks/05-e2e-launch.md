# Block 5 — End to end and launch (O40–O43, gates OG3, OG3b, OG4)

Plan §11.3, §12.6–§12.10, §15, §16.2, §17, §13 rows O40–O43. Format and rules: header of
`docs_oracle/check_tasks.py`. Every scenario keeps its evidence (tx hashes, logs, screenshots) in
`docs_oracle/evidence/<gate>/<scenario>/`.

## O40 · Testnet E2E E1–E11 (stub engine)
Plan §13: owner both · 3 PD · depends OG2, O31–O38 · acceptance: all pass.

### O40.1 · Services on testnet and the E2E harness
- Owner: OB
- PD: 0.5
- Depends: OG2, O31.4, O32.3, O33.5, O34.4, O35.4, O36.2, O37.3, O38.5
- Plan: §11.3, §12.7
- Cut: no
- Status: done
- Files: oracle/e2e/**, docs_oracle/evidence/OG3/
- Build: Deploy keeper ×2 (two providers), snapshotter and panel runner, committee console, alerts and the indexer for testnet per §12.7; scenario scripts that list markets with `minHorizonSecs = 10 min`, drive each step and write evidence.
- Done when: a dry scenario (list → halt) runs end to end through the deployed services.
- Check: manual: deployed service endpoints and one dry scenario log in docs_oracle/evidence/OG3/
- Notes: Done 4-5 Oct 2026 (ADJ-52): oracle/e2e drives the scenarios against the deployed oracle with the keeper, panel runner, watchdog, indexer and CRE listener running; the dry scenario (list → halt) passed, the keeper halting at T exactly. Evidence: docs_oracle/evidence/OG3/DRY/ and OG3/README.md.
### O40.2 · E1 and E8
- Owner: OB
- PD: 0.5
- Depends: O40.1
- Plan: §11.3, E1, E8
- Cut: no
- Status: todo
- Files: docs_oracle/evidence/OG3/E1, docs_oracle/evidence/OG3/E8
- Build: E1 full L1 path with a 2-minute liveness; E8 fifteen markets sharing one T, all through L1.
- Done when: E1 Final YES/NO with `settle` called once and claims open; E8 all Final, no drops after keeper retries.
- Check: manual: E1 and E8 evidence with tx hashes

### O40.3 · E2, E3 and E4
- Owner: OA
- PD: 0.5
- Depends: O40.1
- Plan: §11.3, E2, E3, E4
- Cut: no
- Status: done
- Files: docs_oracle/evidence/OG3/E2, docs_oracle/evidence/OG3/E3, docs_oracle/evidence/OG3/E4
- Build: E2 provider blocked → escalate → panel → Review → committee → assert → public dispute → sandbox answers true → Final; E3 the same with false → committee proposes a different outcome → Final; E4 YES rejected then NO rejected → Voided → `settleInvalid` → INVALID price at the T capture.
- Done when: E2 path REVIEWED and visible on Disputes Live; E3 `rejectedMask` set and no repeat; E4 INVALID payouts.
- Check: manual: E2, E3 and E4 evidence with tx hashes
- Notes: Done 4 Oct 2026: E2, E3 and E4 passed on testnet (ADJ-52). Evidence: docs_oracle/evidence/OG3/E2, E3, E4.
### O40.4 · E5 and E7
- Owner: OA
- PD: 0.5
- Depends: O40.1
- Plan: §11.3, E5, E7
- Cut: no
- Status: done
- Files: docs_oracle/evidence/OG3/E5, docs_oracle/evidence/OG3/E7
- Build: E5 no proposal by the L2 deadline → Open → permissionless proposal with own bond → Final; E7 never-answered dispute → `voidMarket` at `voidDeadline` (voidSecs 2 h).
- Done when: E5 bond returned and reward paid or IOU recorded; E7 Final INVALID with the stuck bond recorded.
- Check: manual: E5 and E7 evidence with tx hashes
- Notes: Done 4 Oct 2026: E5 (permissionless proposal, bond returned and 1 USDC RewardPaid) and E7 (void at the deadline, BondStuck recorded) passed. Evidence: docs_oracle/evidence/OG3/E5, E7.
### O40.5 · E6 and E9
- Owner: OA
- PD: 0.5
- Depends: O40.1
- Plan: §11.3, E6, E9
- Cut: no
- Status: done
- Files: docs_oracle/evidence/OG3/E6, docs_oracle/evidence/OG3/E9
- Build: E6 monitor reduce-only → EarlyCheck → panel known → EarlyReview → committee → engine halts before T → Final before T; E9 exclusive group of three with two racing YES reports.
- Done when: E6 `haltedAt < T` and claims before T; E9 a single Final YES (ORC-7).
- Check: manual: E6 and E9 evidence with tx hashes
- Notes: Done 4 Oct 2026: E6 (Final before T) and E9 (single Final YES in the group, ORC-7) passed (ADJ-52 on E9). Evidence: docs_oracle/evidence/OG3/E6, E9.
### O40.6 · E10 and E11
- Owner: OB
- PD: 0.5
- Depends: O40.1, X01
- Plan: §11.3, §12.6, §12.8, §7.6, E10, E11, ADJ-21
- Cut: no
- Status: todo
- Files: docs_oracle/evidence/OG3/E10, docs_oracle/evidence/OG3/E11
- Build: Needs CRE deploy access (X01, ADJ-21). E10 workflow redeploy with a two-ID trust set while markets are L1Pending (§12.8 drain); E11 staging deploy with a production trust set on the KeystoneForwarder, one successful production report, then `lockProduction`, then a mock-forwarder report reverts.
- Done when: E10 no market rejected; E11 ORC-13 holds on testnet.
- Check: manual: E10 and E11 evidence with tx hashes

## O41 · Runbooks and incident drills
Plan §13: owner both · 1.5 PD · depends OG3 · acceptance: two drills done (provider outage, wrong proposal).

### O41.1 · Runbooks
- Owner: OB
- PD: 0.75
- Depends: OG3
- Plan: §15, ADJ-04
- Cut: no
- Status: todo
- Files: docs_oracle/runbooks/*.md
- Build: One runbook per §15 situation (provider outage, schema change, wrong proposal, treasury short, DVM vote rolling, key compromise, workflow redeploy, CRE outage, watchdog down, engine `settle*` reverting), each with detection (which alert), the exact commands or Safe transactions, and the expected end state.
- Done when: every §15 row has a runbook that an on-call person can follow without the plan.
- Check: manual: docs_oracle/runbooks/ holds one runbook per §15 row

### O41.2 · Drills
- Owner: OA
- PD: 0.75
- Depends: O41.1
- Plan: §15
- Cut: no
- Status: todo
- Files: docs_oracle/evidence/O41/
- Build: Run the provider-outage drill and the wrong-proposal drill on testnet strictly from the runbooks; fix any runbook step that did not work.
- Done when: both drills reached their expected end state from the runbook alone.
- Check: manual: both drill logs in docs_oracle/evidence/O41/

## O42 · Re-run E2E against the real engine and factory (gate OG3b)
Plan §13: owner both · 2 PD · depends DEP-1/2 · acceptance: OG3b.

### O42.1 · Switch to the real factory
- Owner: OA
- PD: 1
- Depends: DEP-1, DEP-2, X04
- Plan: §3.3, §12.5, §12.9, §14.1, DEP-1, DEP-2, V-E1
- Cut: no
- Status: todo
- Files: oracle/deployments/monad-testnet.json, oracle/deployments/params.monad-testnet.json
- Build: Check the real `MarketFactory` against `IMarketFactory` (bound to the registry, `onlyRegistry`, atomic deploy + initialize + register, reverts on reuse); Timelock `setFactory`; new globals version with `minHorizonSecs = 86,400`; list the E2E markets the day before (T ≥ listing + 24 h, voidSecs 26 h).
- Done when: one market is listed through the real factory and its `listing()` matches the pack.
- Check: manual: setFactory and createMarket tx hashes, engine listing check in docs_oracle/evidence/OG3b/
- Local implementation update (2026-10-05): code-store factory, dedicated vault and registry-bound engine now have local integration tests. See `docs/integration/REAL_FACTORY_INTEGRATION.md`. Status stays todo: no local account controls the current deployment, and no Timelock switch/listing receipt has been produced. Real packs also need the bounded-text/gas preflight and actual collateral/INDEX identities.

### O42.2 · E1–E11 on the real engine
- Owner: OB
- PD: 1
- Depends: O42.1
- Plan: §11.3, V-E1, E1, E2, E3, E4, E5, E6, E7, E8, E9, E10, E11
- Cut: no
- Status: todo
- Files: docs_oracle/evidence/OG3b/
- Build: Re-run every scenario of O40 against the real engine and factory; compare each result with the stub-engine run (V-E1).
- Done when: all eleven pass and any behaviour difference from the stub is explained and fixed.
- Check: manual: E1–E11 evidence in docs_oracle/evidence/OG3b/
- Local implementation update (2026-10-05): real oracle/registry/book/risk cash-lifecycle regressions exercise authenticated reports, early and scheduled outcomes, rejection/dispute/void paths and owner claims. Token, INDEX and assertion verdicts remain explicit fixtures. These are not a replacement for all eleven live scenarios or CRE deployment access.

## O43 · Production venue, external audit and mainnet (gate OG4)
Plan §13: owner both · no estimate · depends OG3b · acceptance: OG4.

### O43.1 · Production venue (R-2)
- Owner: OA
- PD: -
- Depends: OG3b, X02
- Plan: §6.7, §16.2, R-2, V-U8, V-U9
- Cut: no
- Status: skipped
- Files: oracle/src/venues/*
- Build: Either (a) a new UmaAdapter pointing to UMA OOv3 on Monad, or (b) a `RelayVenue` on Monad plus a Base asserter linked by CCIP (lane confirmed); then read the venue's burned bond share (V-U8) and USDC minimum bond (V-U9) on chain. The state machine is unchanged; only `IAssertionVenue` changes.
- Done when: the chosen venue passes the O13 suites adapted to it and the two values are recorded.
- Check: manual: venue decision, V-U8 and V-U9 values with the cast commands recorded in docs_oracle/evidence/OG4/
- Notes: Skipped: mainnet is out of hackathon scope (ADJ-51).
### O43.2 · DVM parameters and the void bound
- Owner: OA
- PD: -
- Depends: OG3b
- Plan: §14.2, §16.2, V-U6
- Cut: no
- Status: skipped
- Files: docs_oracle/evidence/OG4/
- Build: Read `maxRolls` and the vote timing on Ethereum VotingV2 (V-U6); recompute the §14.2 bound; if it exceeds 45 days, raise `voidSecs` and `dvmMaxRolls` for new listings.
- Done when: production `voidSecs` covers the measured worst case.
- Check: manual: V-U6 values and the recomputed bound recorded in docs_oracle/evidence/OG4/
- Notes: Skipped: mainnet is out of hackathon scope (ADJ-51).
### O43.3 · External audit
- Owner: both
- PD: -
- Depends: OG3b
- Plan: §12.10
- Cut: no
- Status: skipped
- Files: docs_oracle/audit/*
- Build: External audit of `oracle/src`; merge every fix; invariants ORC-1…15 green at the `ci` profile afterwards.
- Done when: the report and the fix list (each with its commit) are committed.
- Check: cd oracle && FOUNDRY_PROFILE=ci forge test
- Notes: Skipped: mainnet is out of hackathon scope (ADJ-51).
### O43.4 · Mainnet launch
- Owner: both
- PD: -
- Depends: O43.1, O43.2, O43.3
- Plan: §12.6, §12.10, §14.1, §17
- Cut: no
- Status: skipped
- Files: oracle/deployments/monad-mainnet.json, docs_oracle/evidence/OG4/
- Build: Every §12.10 checklist item: venue live (no sandbox); Timelock ≥ 48 h; guardian Safe; keys in HSM/KMS or hardware wallets; production trust set (mainnet KeystoneForwarder, workflow ID, org owner) and `lockProduction()` before the first listing; a mainnet report with `ReportProcessed(result=true)`; treasury funded and limits set; watchdog green 7 days on testnet; validation report published; parameters recorded with source, date and owner; 45-day and DEC-08 disclosures in the UI; legal review.
- Done when: every checklist item is ticked with its evidence.
- Check: manual: the §12.10 checklist with evidence links in docs_oracle/evidence/OG4/checklist.md
- Notes: Skipped: mainnet is out of hackathon scope (ADJ-51).
