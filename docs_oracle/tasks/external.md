# External actions (X01–X04) and external dependencies

The plan requires these actions but plan §13 gives them no task ID and no estimate (ADJ-19). They are
tracked here so nothing waits on them unnoticed. Format and rules: header of
`docs_oracle/check_tasks.py`. PD is `-` because the plan gives none.

### X01 · CRE account and deploy access
- Owner: OB
- PD: -
- Depends: -
- Plan: §12.3, §7.6, V-C11, V-C14
- Cut: no
- Status: todo
- Files: oracle/deployments/monad-testnet.json
- Build: Start on day 1 (approval is manual). Create the Chainlink account and organization, `cre login`, `cre whoami`; request deploy access with `cre account access` using the §12.3 use-case text; choose the private registry; record the organization owner address (`TrustSet.workflowOwner`); agree the 3-workflow quota with CP-PRICE (resolution + index relay + 1 spare).
- Done when: deploy access is granted and the org owner address is recorded under `cre.orgOwner`.
- Check: manual: approval email date and orgOwner recorded in oracle/deployments/monad-testnet.json

### X02 · Production venue outreach (R-2)
- Owner: lead
- PD: -
- Depends: -
- Plan: §6.7, §16.2, §17, R-2
- Cut: no
- Status: todo
- Files: docs_oracle/requests/R-2-venue.md
- Build: Start now. Ask UMA / Risk Labs for an OOv3 on Monad (timeline, relay model, USDC whitelisting and final fee); in parallel confirm the Base↔Monad CCIP lane for option (b).
- Done when: a venue option is chosen with its expected date, or both are documented as unavailable.
- Check: manual: docs_oracle/requests/R-2-venue.md records the answers and the chosen option

### X03 · Accounts, keys and Safes
- Owner: both
- PD: -
- Depends: O01.2
- Plan: §12.1
- Cut: yes
- Status: todo
- Files: oracle/deployments/params.monad-testnet.json
- Build: Every §12.1 role: hardware-wallet deployer; team Safe (2-of-3) and guardian Safe (2-of-3) on app.safe.global; three committee wallets; KMS secp256k1 runner attestor; watchdog key in a separate cloud account; two keeper/relayer EOAs; the sim relayer EOA (testnet only); fund each with testnet MON. The bond token follows the O01.2 decision.
- Done when: every address is in `params.monad-testnet.json` and no private key is in git.
- Check: manual: every §12.1 role has an address in oracle/deployments/params.monad-testnet.json

### X04 · Testnet deployment
- Owner: OA
- PD: -
- Depends: OG1, X03
- Plan: §12.4, §12.5, §12.11, §14.1, V-M3, V-C16, ADJ-18, ADJ-20
- Cut: yes
- Status: todo
- Files: oracle/deployments/monad-testnet.json
- Build: The "OG1 deploy" that O23 waits for (ADJ-20). Re-verify every external address with `cast code`; run DeployUmaSandbox and DeployOracle; verify on the testnet explorer; queue and execute the §12.5 Timelock operations (sim forwarder, sim relayer, trust set 1 and its activation, globals version 1, providers, authRefs, treasury limits); fund the ASSERTION and WATCHDOG_FLOAT ledgers; list the first market and record `createMarket` gas (V-M3).
- Done when: `deployments/monad-testnet.json` holds every address, code hash, deploy block and Timelock operation, and the first market is listed.
- Check: manual: oracle/deployments/monad-testnet.json complete and the first MarketListed tx hash recorded

## External dependencies (other teams, plan §3.3)

| ID | Owner | What the oracle needs | Needed by |
| --- | --- | --- | --- |
| DEP-1 | Risk A+B | A concrete `MarketEngine` implementing `IResolutionEngine`, `IMarketConfig`, `RiskView` | O42 (OG3b) |
| DEP-2 | Shared (CP-FACTORY) | `MarketFactory.deployMarket(listing, engineInit)` per C.6, `onlyRegistry`, atomic | O42 (OG3b) |
| DEP-3 | Risk B | Confirm the oracle enum, the `Listing` fields and `voidSecs` = 45 days | O01 (OG0) |
| DEP-4 | Risk B | Keep `RiskView.marketRiskView().monitorRestricted` on the production engine | O01 (OG0), O14.5 |
| DEP-5 | App team | Indexer/frontend host for Disputes Live | O37.3, O38 |
