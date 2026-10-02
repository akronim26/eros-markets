# Oracle ownership

Task O00.1. Plan §6.1, §12.2a, D18; ADJ-04.

The oracle team (OA, OB) is the only editor of these paths:

| Path | What it holds |
| --- | --- |
| `oracle/**` | The oracle Foundry project (`src/`, `test/`, `script/`, `vectors/`, `abi/`, `deployments/`), its submodules under `oracle/lib/`, and the workflows, packages, services, indexer, apps and validation pipeline |
| `docs_oracle/**` | The plan, the task breakdown, gates, adjustments, progress, evidence, requests, runbooks and reports |
| `.github/workflows/oracle.yml` | Oracle CI |

The oracle team edits nothing else in the repository. In particular:

- `contracts/**` (the order book and the Risk & Clearing engine) is **read-only**. Oracle code imports it
  only through the `oracle/foundry.toml` remappings:
  - `@eros/` → `../contracts/src/` (engine interfaces; and B's real settlement modules, in seam tests only)
  - `@eros-provisional/` → `../contracts/provisional/`
  - `@eros-test/` → `../contracts/test/` (non-test mocks such as `mocks/A/MockUSDC.sol` and `mocks/B/*`)
- **Never import a `contracts/**/*.t.sol` file.** It would compile twice under two paths and make the
  oracle CI run the Risk suites.
- Oracle sources in `oracle/src/` depend only on Solady and engine **interfaces** (`@eros/interfaces/*`).
  UMA code (AGPL-3.0) is compiled only for tests and the sandbox deploy script.
- `.github/workflows/contracts.yml`, `.gitmodules` entries under `contracts/lib/` and every
  `docs/` file belong to other teams. A change needed there is written up as a request in
  `docs_oracle/requests/` (created when the first request is written) and sent to its owner.

Submodules (pinned in `.gitmodules`, plan §12.2a):

| Path | Commit |
| --- | --- |
| `oracle/lib/forge-std` | `f3dae6e6ee381f25eb6a246f7da9b85c91a68219` (same as `contracts/lib`) |
| `oracle/lib/solady` | `2afba69bf67b78dd4abeadcc696052b3a6f71499` (same as `contracts/lib`) |
| `oracle/lib/openzeppelin-contracts-v4` | `dc44c9f1a4c3b10af99492eed84f83ed244203f6` (v4.9.6, UMA dependency) |
| `oracle/lib/uma-protocol` | `d1a2373e2e0a3cbb28bce48ca72379a2abb97c69` (shallow; tests and sandbox only) |
