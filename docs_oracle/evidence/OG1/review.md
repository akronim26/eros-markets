# OG1 · Internal review of the oracle contracts

Gate OG1 ("Contracts complete") exit criteria: oracle CI green at `FOUNDRY_PROFILE=ci`, and an internal review of the
contracts diff recorded (ADJ-35: the team's own review stands in for "a review by OB").

- **Scope:** every file under `oracle/src/`, O10–O19, 3,955 lines:
  - `ResolutionOracle.sol`, `MarketRegistry.sol`, `BondTreasury.sol`, `KeeperRouter.sol`;
  - `venues/UmaAdapter.sol`, `venues/ErosSandboxOracle.sol`;
  - `libraries/` (SigLib, FeedSpecLib, HostLib, ClaimRenderer, BondMath, VoidBound);
  - `testnet/` (ResolutionEngineStub, StubMarketFactory, TestUSDC), the types and the interfaces.
- **Baseline:** commit `46991be` (branch `feat/oracle`).
- **Reviewer:** the team's coding agent (Claude), 3 Oct 2026. **This is an internal review, not an external audit.** The
  external audit of `oracle/src` remains an OG4 (mainnet) requirement (plan §12.10).
- **Sign-off:** the review counts for OG1 once a team member has read it and signed below.

## Method

Each contract was read in full against:
- the plan's state machine (§5.4) and listing rules (§6.3–§6.6);
- the ORC-1…15 invariants (§5.5);
- the C.1/C.3/C.6 interfaces and the audit items the plan cites (D-, S- and V- references).

The existing evidence was taken into account:
- unit and fuzz suites per task;
- the ORC-1…15 invariant suite with handler steering (O17.2), whose planted mutants are caught, ORC-6 and ORC-7 at the
  `ci` profile;
- the real-UMA suites (O13.2, O13.3);
- the seam with B's real `SettlementController` (O17.3);
- the shared FeedSpec/EIP-712/claim vectors (O10, O16, O20.2);
- the gas budgets (O18.1).

## Result

**No critical, high or medium findings.** One low finding (fixed in this review) and five informational notes.

| ID | Severity | Where | Finding | Disposition |
|---|---|---|---|---|
| L-1 | Low (docs) | `ResolutionOracle._applyVenue` / `_recordHalt` | The NatSpec of `_recordHalt` sat above `_applyVenue`, so the generated docs described the wrong function. | **Fixed** in this review (comment moved; no code change). |
| I-1 | Info | `MarketRegistry.createMarket` | `dryRunHash` and `ambiguityLogHash` may be zero: the registry does not require the listing pack's dry run or ambiguity pass. | As designed: §6.3 does not require them; listing discipline is the lister's checklist (§12.9). `oracle-cli` refuses to set `ambiguityLogHash` until the pass succeeds (ADJ-37). |
| I-2 | Info | `BondTreasury.fundAssertion` vs `totalCommitted` | A live team bond is debited from ASSERTION while its market's listing commitment stays counted. After a lost bond, a retry can hit `TreasuryShort` until ASSERTION is topped up. | Conservative, not unsafe: the commitment protects other markets. `assertProposal` reverts `TreasuryShort` with both amounts so the keeper can alert (§6.6). |
| I-3 | Info | `venues/ErosSandboxOracle` | On testnet the sandbox DVM's owner (`SANDBOX_OWNER`) answers every dispute. Under ADJ-38 that is a hot key, not a Safe. | Testnet only. It must be disclosed in the UI (§13.1 rules) and never deployed on mainnet (DeployUmaSandbox refuses chain 143). |
| I-4 | Info | `submitPanelResult` (L2Pending, ≥ 2 NOT_YET) | Re-submitting the same signed NOT_YET result re-emits `PanelNotYet` (no state change). | Harmless: no state or funds change, and the caller pays the gas. |
| I-5 | Info | Seam with `integration/risk` | Risk's branch removes `contracts/provisional/` (moving `FinalOutcome` to `MathTypes.FinalOutcome`) and renames the engine's `Unauthorized()` to `RiskUnauthorized()`. Our `ResolutionEngineStub` and nine test files need the matching edit at merge. | A rehearsal merge with the patch passes all 288 oracle tests against `integration/risk`, including the 5 seam tests on its real settlement code. Apply the patch in the merge commit (it cannot land on `feat/oracle` before Risk's branch does). |

## Checks per area

**ResolutionOracle**
- **Every transition of §5.4 is guarded.** Pre-halt → L1Pending/L2Pending at T; L1 report → Proposed; panel or committee
  proposal → Proposed; assert → Disputed/Final/rejection; void after `voidDeadline`.
- **Keepers never pay for a failed call.** Keeper functions return false or NOT_READY instead of reverting, except for
  the named guards (`TooEarly`, `NoFeed`, `MaxAttempts`, `TreasuryShort`, `ExpiryAfterVoidDeadline`). This matters
  because Monad charges the gas limit on a revert.
- **`onReport`:**
  - the report must be exactly 256 bytes, and it is accepted only in L1Pending, so replays revert (ORC-4);
  - the sender is checked against the market's pinned trust set. On the sim path that means the sim forwarder, a
    relayer `tx.origin` and a non-production set. On the production path it means the set's forwarder, a production
    set, and metadata of at least 62 bytes naming a non-revoked workflow ID, the owner and the name;
  - then the content: version, chain selector, oracle address, outcome ∈ {YES, NO}, the specHash, and `observedAt`
    within `[T + bufferSecs, now]`.
- **Panel:**
  - payload binding: marketId, deadline, attempt, trust set, URI hash, phase, gateHash;
  - the attestor signature must be low-s with v ∈ {27, 28}, and the attestor not revoked;
  - auto gate: binary 3/3 agreement, every calibrated confidence ≥ θ_hi, a category validated for this gateHash
    before the halt with U95 ≤ Δp_max and N ≥ N_min, OI within the review limit, `flags == 0` and an evidence hash.
    Anything else routes to Review.
- **Committee:**
  - signers strictly ascending, non-revoked members, and at least the threshold;
  - ERC-1271 wallets accepted (Solady `SignatureCheckerLib`);
  - the EarlyReview path halts the engine in the same transaction (§8.5).
- **Assertions:**
  - the expiry guard requires `now + liveness ≤ voidDeadline` (D10);
  - the bond is `max(minBond, venue minimum, ceil(OI × 1000 × bondBps / 10⁴))`;
  - L1 and L2_AUTO fall back to the reviewed liveness when the heartbeat is stale or the watchdog revoked (D11);
  - the claim is rendered from the stored template (O18.1, byte-identical to the O10.3 version).
- **Rejection, void and final:**
  - a rejected outcome is masked (ORC-6); YES and NO both rejected → Voided → Final INVALID;
  - `voidMarket` first applies a settled or settleable assertion (ORC-9);
  - Final calls the engine in the same transaction, so a conflicting delivery rolls everything back (S-02);
  - each final reason gets exactly one treasury booking, and the listing commitment is released.
- **Exclusive groups:** a single YES lock; a Final YES keeps the lock; a YES in a group that already has a Final YES
  goes back to Review without using an attempt (ORC-7).
- **Halt:**
  - `haltedAt = economicHaltAt` (T for a late scheduled halt);
  - `voidDeadline = max(haltedAt, T) + voidSecs`, set once;
  - the trust set and the globals version are pinned (ORC-11, ORC-12).
- **Governance and guardian:**
  - trust sets are append-only and checked with codes 1–9;
  - `lockProduction` is one-way and needs a production set;
  - sim mode is impossible on chainId 143;
  - the guardian can only revoke, with immediate effect on pinned sets;
  - there is no pause and no admin path that moves a market (D20).

**MarketRegistry**
- Rules 1–6 in order, each reverting with its first failing code: identity and groups, times and the void bound,
  FeedSpec (parity with the TypeScript evaluator through the shared vectors), allow-list, AI config, UMA config with
  template tokens and worst-case claim length.
- Step 7 commits the bond at the OI cap.
- Step 8 overwrites the seam fields, deploys through the factory, and checks the engine's listing hash and that it is
  not halted.
- Step 9 stores the config immutably (SSTORE2 for long text; no setters, ORC-1).
- Governance setters are Timelock-only; globals are versioned and append-only.

**BondTreasury**
- Ledgers are isolated, and deposits credit what actually arrived.
- Listing commitments: `withdraw` never goes below `totalCommitted`.
- `fundAssertion` is oracle-only and per-market capped (`maxPerMarket`, 0 until `setLimits`).
- Bookings: returned, lost and stuck bonds are each cleared once.
- The proposer reward never reverts `_final`: a shortage becomes an IOU.
- Watchdog disputes: only the pinned watchdog, only on a live undisputed assertion, capped open disputes, closed once.
- `skim` credits only unaccounted USDC.

**Venues**
- `UmaAdapter`:
  - only the oracle asserts and only the treasury disputes through it;
  - callbacks only record and never revert;
  - settlement and status are read from OOv3 (pull model, so a late callback changes nothing);
  - the minimum bond comes from OOv3.
- `ErosSandboxOracle`: the requester is set once and answers are push-once (see I-3).

**KeeperRouter**
- Batches with try/catch, so one failing market never blocks the rest. It holds no state and no privileges.

**Libraries**
- SigLib: low-s check and v ∈ {27, 28} for the attestor; committee sorted, unique and non-revoked.
- FeedSpecLib and HostLib: §6.3 rule 3 with shared-vector parity (72 cases).
- ClaimRenderer: token rules, worst-case bound, gas-optimized with a parity test.
- BondMath and VoidBound: §6.5 and §14.2 formulas, with vectors.

**Testnet contracts**
- The stub engine mirrors the real engine's errors and settlement semantics (I-5 lists the rename to apply at merge).
- `StubMarketFactory` is registry-only.
- `TestUSDC` refuses chain 143 and caps its faucet.

## CI

Oracle CI runs `FOUNDRY_PROFILE=ci` (fmt check, build with sizes, unit, fuzz, the 15 invariants at 256 × 128, real
UMA, seam, vectors), plus the packages, workflow and dryrun jobs.

Both runs below passed every job (forge, packages, workflow, dryrun). `7119c72` includes this review's L-1 fix.

| Commit | Run | Result |
|---|---|---|
| `46991be` | 37105657314 | success |
| `7119c72` | 37105877808 | success |

## Sign-off

The gate passes when CI is green and a team member signs here. Its `merge_sha` is then recorded in
`docs_oracle/gates.json` by that person.

- [x] Reviewed and accepted by: xipharis, date: 3 October 2026
