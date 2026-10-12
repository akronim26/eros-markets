# Native deployment rehearsal (local fork)

- Date: 2026-10-13. Tasks: NM-D02/D03 rehearsal, NM-F02 rules. Environment: anvil fork of Monad testnet (chain 10143). **Fork only, no public transactions.**
- `forge script script/native/DeployNativeMarket.s.sol` (forge 1.5.1; forge 1.8.3 rejects anvil's "Prague" hardfork for chain 10143, a fork-only quirk) deployed:
  - the vault, which created YES and NO;
  - the YES/tUSDC and NO/tUSDC Kuru books (0/0 bps fees, precisions 1000/1000, tick 1).

  Estimated gas was about 7.1M. Outputs: [deployment.json](deployment.json), from [params.json](params.json).
- Checks:
  - Each book's base is its outcome token and its quote is TestUSDC.
  - `vault.yes()` matches.
  - `issuanceOpen()` is false while unbound.
  - `bindMarket()` reverts `NotListed` (0x665c1c57), because the rehearsal market is not on the real registry.
  - Rerunning the script refuses with `NATIVE_DEPLOYMENT_EXISTS`.
- `node dist/scripts/native-rules.js deployment.json <signer> 100000 50000000000000000 rules.json` produced [rules.json](rules.json) and the ListMarket engine-listing fields (`indexSourceId`, `indexSigner`, `indexRulesHash`, depth rule).
- The signer above is anvil's public test key #1, a placeholder only.
