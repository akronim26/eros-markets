# Block 0 — Foundation (O00–O02, gate OG0)

Plan §12.2, §12.2a, §13 rows O00–O02. Format and rules: header of `docs_oracle/check_tasks.py`.

## O00 · Scaffold `oracle/`
Plan §13: owner OA+OB · 1 PD · depends — · acceptance: CI green on an empty skeleton; `contracts.yml` untouched.

### O00.1 · Foundry project, submodules and ownership note
- Owner: OA
- PD: 0.25
- Depends: -
- Plan: §6.1, §12.2, §12.2a, D18, ADJ-03, ADJ-04
- Cut: yes
- Status: done
- Files: oracle/foundry.toml, oracle/.gitignore, .gitmodules, oracle/lib/*, docs_oracle/ownership.md
- Build: Install Foundry v1.8.3. Write `oracle/foundry.toml` exactly as plan §6.1. Add the four submodules at the pinned commits of §12.2a (forge-std f3dae6e, solady 2afba69, OpenZeppelin dc44c9f = v4.9.6, UMA protocol d1a2373 shallow, with `shallow = true` in `.gitmodules`). `oracle/.gitignore` covers out/, cache/, node_modules/, .env. Write `docs_oracle/ownership.md`: the oracle team owns `oracle/**`, `docs_oracle/**` and `.github/workflows/oracle.yml`; `contracts/**` is read-only and imported through the `@eros/`, `@eros-provisional/`, `@eros-test/` remappings; never import a `contracts/**/*.t.sol`.
- Done when: `forge config` in `oracle/` prints no warning and resolves both profiles (default 1,000 fuzz / 64×64 invariant; `ci` 10,000 / 256×128); `git submodule status` shows the four pinned commits.
- Check: cd oracle && forge config && FOUNDRY_PROFILE=ci forge config

### O00.2 · UMA compile check and toolchain smoke test
- Owner: OA
- PD: 0.25
- Depends: O00.1
- Plan: §12.2a, B.8, ADJ-02, ADJ-28
- Cut: yes
- Status: done
- Files: oracle/test/uma/UmaImports.sol, oracle/test/vectors/Toolchain.t.sol, oracle/foundry.toml
- Build: Add `test/uma/UmaImports.sol` verbatim from Appendix B.8 (pragma 0.8.16). Add a 0.8.30 test that `deployCode`s `Finder.sol:Finder` and asserts a non-zero address, and that one `@eros/` interface import compiles. This proves auto-detect compiles both solc versions and that `forge test` has at least one test (an empty project fails `forge test`).
- Done when: `forge build` compiles UMA (0.8.16) and the test (0.8.30); the smoke test passes; `forge fmt --check` is clean.
- Check: cd oracle && forge fmt --check && forge build --sizes && forge test --match-path test/vectors/Toolchain.t.sol

### O00.3 · Bun workspace
- Owner: OB
- PD: 0.25
- Depends: O00.1
- Plan: §9, §12.2, ADJ-10
- Cut: yes
- Status: done
- Files: oracle/package.json, oracle/tsconfig.base.json
- Build: Create the bun workspace root `oracle/package.json` with workspaces `packages/*` and `services/*` only (the CRE workflows stay standalone packages with their own `bun.lock`, ADJ-10). Pin bun 1.3.13 (`packageManager`), Node 22, and a shared `tsconfig.base.json` (strict, ES2022, bundler resolution).
- Done when: `bun install` and `bun install --frozen-lockfile` at `oracle/` exit 0 with no members yet. Bun deletes an empty lockfile, so `oracle/bun.lock` is first created and committed with the first member that has dependencies (O20.1).
- Check: cd oracle && bun install --frozen-lockfile
- Notes: ADJ-10 checked with bun 1.3.13 in a scratch copy: a package under `workflows/` installs standalone with its own `bun.lock` and `node_modules`, and the workspace lockfile does not list it.

### O00.4 · Oracle CI (Foundry job)
- Owner: OB
- PD: 0.25
- Depends: O00.2, O00.3
- Plan: §12.2a, §11.1, ADJ-02, ADJ-11
- Cut: yes
- Status: done
- Files: .github/workflows/oracle.yml
- Build: Add `.github/workflows/oracle.yml` with the `on.paths` filters, permissions and the `forge` job copied verbatim from plan §12.2a (`FOUNDRY_PROFILE=ci`, Foundry v1.8.3, fmt check, build with sizes, test). The `workflow` job of §12.2a is added in O21.4, when the workflow exists (ADJ-02).
- Done when: the job is green on the branch; `.github/workflows/contracts.yml` is unchanged.
- Check: git diff --exit-code 0e7a2af -- .github/workflows/contracts.yml

## O01 · Seam agreement with Risk and the factory owner
Plan §13: owner OA · 1 PD · depends — · acceptance: written in the seam request, acknowledged by both Risk devs.

For the hackathon the oracle team decides the seam itself instead of waiting for acknowledgement
(ADJ-29); the decisions conform to the engine code and need no engine change.

### O01.1 · Decide the seam
- Owner: OA
- PD: 0.5
- Depends: -
- Plan: §3.2, §3.3, §6.2, DEP-1, DEP-2, DEP-3, DEP-4, DEP-5, ADJ-24, ADJ-25, ADJ-29
- Cut: yes
- Status: done
- Files: docs_oracle/seam-decisions.md
- Build: One decision per seam item, each citing the engine source it conforms to: oracle enum and B's unused `VOIDED = 4`; engine calls; clocks; bond units; `bytes32` marketId; listing hash; the `Listing` fields the registry overwrites; `voidSecs`; the monitor flag; the listing horizon; the `IMarketFactory` ABI; the engine used for the hackathon; the testnet bond token; the Disputes Live host; the seam tests.
- Done when: `docs_oracle/seam-decisions.md` holds S-01–S-15, each with a decision and its basis, and none requires an engine change.
- Check: manual: docs_oracle/seam-decisions.md lists S-01–S-15 with a decision and a source each
- Notes: Replaces the earlier seam request (removed); see ADJ-29.

### O01.2 · Apply the decisions to the breakdown
- Owner: OA
- PD: 0.5
- Depends: O01.1
- Plan: §3.3, §12.1, DEP-3, DEP-4, ADJ-29
- Cut: yes
- Status: done
- Files: docs_oracle/gates.json, docs_oracle/adjustments.md, docs_oracle/tasks/*.md
- Build: Carry each decision into the tasks it affects: OG0 exit criteria; the testnet bond token in O19.3 and X03; DEP-3/DEP-4 in `tasks/external.md`; ADJ-24/ADJ-25 resolutions. Any change to an Appendix C type would be made in O02 before OG0 (none is needed).
- Done when: no task or gate still waits on a Risk acknowledgement, and the validator passes.
- Check: python3 docs_oracle/check_tasks.py

## O02 · Types and interfaces
Plan §13: owner OA · 1 PD · depends O00 · acceptance: compiles; ABI snapshot committed.

### O02.1 · Copy Appendix C and B.7 unchanged
- Owner: OA
- PD: 0.5
- Depends: O00.1, O00.2, O00.3, O00.4
- Plan: §5.1, §5.2, §6.2, C.1, C.2, C.3, C.4, C.5, C.6, B.7
- Cut: yes
- Status: todo
- Files: oracle/src/types/OracleTypes.sol, oracle/src/interfaces/{IResolutionOracle,IMarketRegistry,IBondTreasury,IReceiver,IMarketFactory,IEngineMonitorView,IKeeperRouter,IAssertionVenue,IOptimisticOracleV3}.sol
- Build: Copy C.2–C.6 and B.7 byte for byte (C.6 is four files). No edits: enum values are ABI.
- Done when: `forge build` succeeds and `forge fmt --check` is clean.
- Check: cd oracle && forge fmt --check && forge build

### O02.2 · Constants test, C.7 vectors and ABI snapshot
- Owner: OA
- PD: 0.5
- Depends: O02.1
- Plan: C.7, §11.2, ADJ-08, ADJ-09
- Cut: yes
- Status: todo
- Files: oracle/test/vectors/Constants.t.sol, oracle/vectors/{eip712,spechash,voidbound,bond}.json, oracle/abi/*.json, oracle/abi/SHA256SUMS
- Build: Assert in Foundry: `type(IReceiver).interfaceId == 0x805f2132`; `ResolutionRequested` topic0 `0xa3af…3a13`; `RState.L1Pending == 3`; `getL1Job` selector `0xad3a62cf`; both EIP-712 typehashes. Commit the C.7 vector inputs and expected values (P1, R1, specHash of the B.3 FeedSpec, both void bounds, the 2,000,000-lot bond) as JSON. Export `forge inspect <X> abi` for every interface into `oracle/abi/` with a `SHA256SUMS` file.
- Done when: the constants test passes and the ABI snapshot plus checksums are committed.
- Check: cd oracle && forge test --match-path test/vectors/Constants.t.sol && cd abi && sha256sum -c SHA256SUMS
