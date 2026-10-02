# Block 2 — Layer 1 workflow (O20–O23, gate OG2)

Plan §7, §11.2, §12.6, §12.9, §13 rows O20–O23. Format and rules: header of
`docs_oracle/check_tasks.py`. Pinned versions (§7.2): `@chainlink/cre-sdk` 1.23.0, viem 2.57.2,
zod 4.6.5, TypeScript 5.4.5, `@bufbuild/protobuf` 2.6.3, bun 1.3.13.

## O20 · `packages/feedspec`
Plan §13: owner OB · 1 PD · depends OG0 · acceptance: bun tests (A1) + vectors.

### O20.1 · Evaluator package and its tests
- Owner: OB
- PD: 0.5
- Depends: OG0
- Plan: §7.3, §11.2, B.2, ADJ-11, ADJ-12
- Cut: yes
- Status: done
- Files: oracle/packages/feedspec/{package.json,tsconfig.json,src/index.ts,test/evaluator.test.ts}, oracle/bun.lock, .github/workflows/oracle.yml
- Build: Move B.2 into the package and add the `{id}`-after-the-first-slash check to `buildUrl` (B.2 note). Tests for every §11.2 evaluator case: finished → YES/NO; live → NOT_READY; wrong path → ERROR; DECIMAL 3.10 vs 3.1 at decimals 2 equal; 3.105 → ERROR; exponent → ERROR; INT rejects 3.0 and "03"; HTTP 429/5xx, oversize and invalid JSON → ERROR; STRING only EQ/NEQ; big integers keep precision; duplicate keys rejected; URL and host rules. Add a `packages` job to `oracle.yml` that runs `bun test` for the workspace (ADJ-11).
- Done when: all tests pass locally and in CI; the package has no runtime dependency and no float on any value.
- Check: cd oracle/packages/feedspec && bun test
- Notes: `@eros-oracle/feedspec` is B.2 with one change: `buildUrl` first runs `checkTemplate`, the registry's `HostLib.checkTemplate` rules in its order (NOT_HTTPS, BAD_HOST on the template's own host, then `{id}` at most once and after the first '/' at or after the end of the host: MULTIPLE_ID_PLACEHOLDERS, ID_NOT_IN_PATH), and only then the urlParam (BAD_URL_PARAM, checked even without `{id}`); B.2 checked the urlParam first and only the substituted URL's host, so `https://{id}.example.com/x` with a param such as `abc` passed in TypeScript while the registry refuses it. `{id}` is replaced with a replacer function (no `$` patterns). Everything else is B.2 as given. No runtime or dev dependency; values are BigInt or exact lexemes (the only `Number` use is an array index). 21 tests, 115 assertions: every §11.2 case (finished YES/NO, live NOT_READY including case and whitespace in finalValue, wrong path, DECIMAL 3.10 == 3.1 at 2 decimals, 3.105 refused without rounding, exponents, INT 3.0 and "03", HTTP 429/5xx/3xx, 250 KiB exactly allowed and one byte more refused, nine invalid JSON bodies, STRING only EQ/NEQ, 2^53 + 1 and 18-decimal precision, duplicate keys) plus the URL, host, allow-list, path and parser rules. The 35 URL-rule cases of `vectors/feedspec.json` (codes 0-4) give the Solidity codes through `buildUrl` (checked by a throwaway script; the full vector parity is O20.2). 10 planted bugs all caught, among them B.2's `buildUrl` as given and float parsing. Workspace: `oracle/bun.lock` is created with this first member (O00.3); `bun install --frozen-lockfile` passes. CI (ADJ-11): job `packages` in `oracle.yml` (bun 1.3.13, frozen install, then `bun run --filter '*' test`, each member's own test script: a bare `bun test` in `oracle/` would also run the vendored libraries' test files under `lib/`; a failing package test fails the step, checked). Not yet confirmed on GitHub until pushed.

### O20.2 · Shared vectors parity with Solidity
- Owner: OB
- PD: 0.5
- Depends: O20.1, O10.2
- Plan: §11.2, C.7, V-R5, ADJ-08
- Cut: yes
- Status: done
- Files: oracle/packages/feedspec/test/vectors.test.ts, oracle/packages/feedspec/src/index.ts, oracle/packages/feedspec/package.json, oracle/bun.lock, oracle/vectors/feedspec.json, oracle/test/unit/FeedSpecLib.t.sol
- Build: Read `oracle/vectors/feedspec.json` and `oracle/vectors/spechash.json` (O02.2, O10.2): every validation vector gives the same accept/reject result in TypeScript; every specHash vector, computed with viem `encodeAbiParameters` on the FeedSpec tuple, equals the Solidity value.
- Done when: the same file passes in bun and Foundry, including `0x5066…80cd`.
- Check: cd oracle/packages/feedspec && bun test test/vectors.test.ts
- Notes: The package had only the evaluator's pieces, so O20.2 adds `validateSpec(spec, l1Host, authRefKnown, bounds)`: `FeedSpecLib.validate` in TypeScript, the first failing BadFeed code in the registry's order 1..12 (https, host, {id}, urlParam, L1 host, path, finalValue, op/type, decimals, target, timing, authRef), built from the evaluator's own rules (`checkTemplate`, the urlParam and path regexes, `parseTyped` for INT and DECIMAL targets, so the listing check and the evaluation cannot disagree; STRING target non-empty); exported with the `BadFeed` codes for the listing CLI (O22). The tests compare exact codes, not only accept or reject: all 72 cases of `vectors/feedspec.json` (every code 0-12 present) and the four `vectors/spechash.json` vectors through viem 2.57.2 `encodeAbiParameters` on the FeedSpec tuple (C.2 order), including B.3's `0x5066…80cd`, plus every field changing the hash. viem is a dev dependency only (the package keeps no runtime dependency; `bun.lock` updated, frozen install passes). 7 planted validator bugs: 6 caught at first; the survivor (path checked before the L1 host) showed no vector exercised that order, so one shared vector was added (`order: L1 host and path both wrong -> L1 host first`, code 5) and the Foundry test's pinned case count raised from 71 to 72; it now catches it. The same files pass in Foundry (`FeedSpecLib.t.sol`, 3/3) and bun (80 vector tests; 101 in the package).

## O21 · `workflows/resolution`
Plan §13: owner OB · 2 PD · depends O20, O02 · acceptance: §11.2 tests; no determinism warnings.

### O21.1 · Workflow project files
- Owner: OB
- PD: 0.5
- Depends: O20.2, O02.2
- Plan: §7.1, §7.2, §7.4, V-C17, ADJ-10
- Cut: yes
- Status: done
- Files: oracle/workflows/{project.yaml,secrets.yaml,.env.example}, oracle/workflows/resolution/{workflow.yaml,config.local-sim.json,config.staging.json,config.production.json,package.json,tsconfig.json,bun.lock}
- Build: Every file exactly as §7.2 (targets local-sim, staging, production; private registry; `config.local-sim.json` equal to staging except the target). `resolution/` is a standalone package with its own `bun.lock`, outside the bun workspace (ADJ-10). `.env.example` names `CRE_ETH_PRIVATE_KEY`, `MONAD_TESTNET_RPC` and provider keys; `.env` is git-ignored.
- Done when: `bun install --frozen-lockfile` succeeds in `resolution/`.
- Check: cd oracle/workflows/resolution && bun install --frozen-lockfile
- Notes: `project.yaml`, `secrets.yaml`, `workflow.yaml`, `package.json` and `tsconfig.json` are §7.2 byte for byte (targets local-sim, staging, production; private registry for staging and production). `config.local-sim.json` is identical to `config.staging.json` (the target lives in `workflow.yaml`); the configs follow §7.2 with two values filled: `authRef` is keccak256("SPORTSDATA_V1") = 0xd2df…f21e, and `oracle` is the zero address until the oracle is deployed on testnet (it passes the zod address check; set it at the testnet deploy, X04/O23, and the mainnet one before production), never an invented address. `.env.example` names CRE_ETH_PRIVATE_KEY (the sim relayer key), MONAD_TESTNET_RPC (the public testnet RPC), MONAD_MAINNET_RPC and SPORTSDATA_API_KEY_VALUE; `.env` is already git-ignored at any depth by `oracle/.gitignore`. ADJ-10 confirmed: `bun install` in `resolution/` is standalone (its own `bun.lock`, the workspace `oracle/bun.lock` unchanged and not referencing it), and `--frozen-lockfile` passes. Installed versions are exactly the §7.2 pins (cre-sdk 1.23.0, viem 2.57.2, zod 4.6.5, TypeScript 5.4.5, @bufbuild/protobuf 2.6.3), with the SDK's own zod 3.25.76 (V-C17). `main.ts` (O21.2) is not there yet, so nothing typechecks or builds at this step.

### O21.2 · Handler `main.ts`
- Owner: OB
- PD: 0.5
- Depends: O21.1
- Plan: §7.3, §7.4, D12, B.1, V-C4, V-C6
- Cut: yes
- Status: todo
- Files: oracle/workflows/resolution/main.ts
- Build: B.1 with the evaluator import changed to `../../packages/feedspec/src/index`. Zod config schema as given. Never `.withDefault(`.
- Done when: `bun run typecheck` is clean.
- Check: cd oracle/workflows/resolution && bun run typecheck

### O21.3 · Handler tests and parity tests
- Owner: OB
- PD: 0.75
- Depends: O21.2
- Plan: §11.2, B.3, C.7
- Cut: yes
- Status: todo
- Files: oracle/workflows/resolution/main.test.ts, oracle/workflows/resolution/parity.test.ts
- Build: B.3 tests plus: unknown `authRef`, specHash mismatch and state ≠ L1Pending write nothing; a YES report decodes to v1 bound to selector, oracle, market, observedAt, valueHash and specHash. Parity test: `RESOLUTION_REQUESTED == 0xa3af…3a13` and `STATE_L1_PENDING == 3`, read from the ABI snapshot in `oracle/abi/` (O02.2).
- Done when: all handler and parity tests pass.
- Check: cd oracle/workflows/resolution && bun test

### O21.4 · WASM build and the CI workflow job
- Owner: OB
- PD: 0.25
- Depends: O21.3
- Plan: §11.2, §12.2a, V-C18, V-C19, ADJ-02
- Cut: yes
- Status: todo
- Files: .github/workflows/oracle.yml
- Build: `bun run build` (`cre-compile main.ts out.wasm`; `out.wasm` is git-ignored). Add the `workflow` job of §12.2a verbatim to `oracle.yml`, including the `.withDefault(` grep that skips `node_modules`.
- Done when: the build prints no determinism warning and the `workflow` CI job is green.
- Check: cd oracle/workflows/resolution && bun run build && ! grep -rn --exclude-dir=node_modules '.withDefault(' --include='*.ts' . ../../packages

## O22 · `workflows/dryrun` and `oracle-cli list`
Plan §13: owner OB · 2.5 PD · depends O21 · acceptance: produces a pack for one real sports market.

### O22.1 · Dry-run workflow
- Owner: OB
- PD: 0.75
- Depends: O21.4
- Plan: §7.2, §7.5, §12.9
- Cut: no
- Status: todo
- Files: oracle/workflows/dryrun/{workflow.yaml,main.ts,main.test.ts,package.json,tsconfig.json,bun.lock}
- Build: Simulation-only workflow: FeedSpec from config (`config.<market>.json`), same fetch, same evaluator and identical consensus as `resolution`, prints YES/NO/NOT_READY/ERROR and writes nothing on chain. Never deployed.
- Done when: SDK-test-runtime tests show the three outcomes and no write; `cre workflow simulate dryrun --target local-sim --limits default` runs with a sample config.
- Check: cd oracle/workflows/dryrun && bun test

### O22.2 · Listing pack generator
- Owner: OB
- PD: 0.75
- Depends: O22.1, O10.3
- Plan: §12.9, ADJ-13, ADJ-16
- Cut: no
- Status: todo
- Files: oracle/packages/oracle-cli/**
- Build: `oracle-cli list` writes `oracle/listings/<marketId>/` with `pack.json` (the `MarketInput`), `reference.json` (captured finished-event response; its keccak is `dryRunHash`) and `claim.txt` (rendered through a Foundry script that calls ClaimRenderer until the oracle-sdk mirror exists, ADJ-16), and checks the claim length against `maxClaimBytes`.
- Done when: a pack is generated for a sample market and `pack.json` passes the registry rules 1–6 in a Foundry dry-run.
- Check: cd oracle/packages/oracle-cli && bun test

### O22.3 · Provider burst test, dry-run log and ambiguity pass
- Owner: OB
- PD: 0.5
- Depends: O22.2
- Plan: §7.4, §12.9
- Cut: no
- Status: todo
- Files: oracle/packages/oracle-cli/**
- Build: Burst test (N parallel requests, one per DON node, no 429); `dryrun.log` from the three configs (finished → YES/NO, live → NOT_READY, wrong path → ERROR); ambiguity pass (rules text given to the three panel models, "list outcomes these rules do not decide"; `ambiguity.log`, `ambiguityLogHash`).
- Done when: all three steps write their files into the pack and fail loudly on a mismatch.
- Check: cd oracle/packages/oracle-cli && bun test

### O22.4 · First real pack
- Owner: OB
- PD: 0.5
- Depends: O22.3
- Plan: §12.9
- Cut: no
- Status: todo
- Files: oracle/listings/<marketId>/*
- Build: Run steps 1–6 of §12.9 for one real sports market, including the rules text with the DEC-08 INVALID disclosure.
- Done when: the complete pack (`pack.json`, `reference.json`, `dryrun.log`, `ambiguity.log`, `claim.txt`) is committed with no open ambiguity.
- Check: manual: oracle/listings/<marketId>/ holds all five files and dryrun.log shows the expected YES/NO, NOT_READY and ERROR

## O23 · Testnet simulation bridge
Plan §13: owner OB · 1 PD · depends O21, OG1 deploy · acceptance: E1 passes in sim mode.

### O23.1 · Broadcast simulation through the mock forwarder
- Owner: OB
- PD: 0.5
- Depends: O21.4, OG1, X04
- Plan: §7.5, §12.6, V-C12, V-C13, ADJ-20
- Cut: yes
- Status: todo
- Files: docs_oracle/evidence/OG2/
- Build: `cast code` both testnet forwarders (V-C12); register the sim relayer key; list one feed market with the stub engine; after T + buffer call `KeeperRouter.haltAndRequest`; run `cre workflow simulate resolution --target local-sim --limits default --evm-tx-hash … --broadcast`; record `onReport` and total `writeReport` gas from the receipts (V-C13).
- Done when: the market is Proposed (L1) on testnet and the gas numbers are written into `deployments/gas.json`.
- Check: manual: ProposedL1 event tx hash and both gas values recorded in docs_oracle/evidence/OG2/

### O23.2 · Continuous `--listen` stand-in and E1
- Owner: OB
- PD: 0.5
- Depends: O23.1
- Plan: §7.5, §11.3, §12.6, E1
- Cut: yes
- Status: todo
- Files: oracle/workflows/listen/ (process-supervisor config), docs_oracle/evidence/OG2/
- Build: Run `cre workflow simulate … --listen --broadcast` under a process supervisor on a team host; then drive E1 end to end (create → T → halt → request → L1 report → assert → liveness → finalize → engine claims enabled).
- Done when: E1 passes in sim mode with `settle` called once; NOT_READY and 429 runs show no write; all three are logged.
- Check: manual: E1, NOT_READY and 429 logs with tx hashes in docs_oracle/evidence/OG2/
