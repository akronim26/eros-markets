# Risk SDK

Read-only risk, settlement and accounting decoders. Contract views remain authoritative;
SDK projections are not spendable balances or permission to act.

## Reproduce the SDK checks

Use Node.js with its test runner (validated locally on Node 22.18.0) and npm. From the repository
root, install the exact locked TypeScript 5.9.3 dependency, then run the existing SDK checks:

```sh
npm ci --prefix packages/risk-sdk --ignore-scripts --no-audit --no-fund
npm test --prefix packages/risk-sdk
```

`npm ci` rejects a package/lock mismatch instead of silently updating the lock; see the
[official npm documentation](https://docs.npmjs.com/cli/v11/commands/npm-ci/).
No global TypeScript install or `npx` download is needed. `node_modules` is ignored by Git.
Generated test JavaScript goes to the repository's existing `tmp/risk-sdk*` directories.

The checks strictly typecheck `src/index.ts`, compile/run A032's accounting assertions, and
compile/run B042's six Node read-model tests against `docs/app-state-fixtures.json`. The
read-model test compilation retains the existing `--noCheck` test-harness behavior; the SDK
source itself is checked separately with `--strict`. This is not a new strict typing claim
for the Node test harness.

`scripts/check-task.sh A032` and `B042` use this same local compiler on every platform and fail
with installation guidance if it is missing or the installed version differs from the manifest.
Their evidence hashes include the package and lock, not installed dependencies. A032 also runs
Forge; the npm commands above do not. A044 assembles existing handoff evidence rather than
compiling the SDK. Toolchain reproducibility does not grant economic review or gate acceptance.
