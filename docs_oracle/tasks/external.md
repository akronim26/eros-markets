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
- Notes: CRE CLI v1.36.0 installed and logged in (org org_M8cSbq73SLqtYxZb). Deploy access requested by the team with `cre account access` on 4 Oct 2026 (private registry; use case: perpetual futures on event markets, Layer 1 resolution workflow); `cre whoami` shows "Not enabled" until Chainlink approves by email. Simulation works meanwhile (O23).

### X02 · Production venue outreach (R-2)
- Owner: lead
- PD: -
- Depends: -
- Plan: §6.7, §16.2, §17, R-2
- Cut: no
- Status: skipped
- Files: docs_oracle/requests/R-2-venue.md
- Build: Start now. Ask UMA / Risk Labs for an OOv3 on Monad (timeline, relay model, USDC whitelisting and final fee); in parallel confirm the Base↔Monad CCIP lane for option (b).
- Done when: a venue option is chosen with its expected date, or both are documented as unavailable.
- Check: manual: docs_oracle/requests/R-2-venue.md records the answers and the chosen option
- Notes: Research and a draft message to UMA in docs_oracle/requests/R-2-venue.md (4 Oct 2026): UMA lists no OOv3 on Monad; the Monad CCIP directory lists a Monad → Base lane (2.0.0); Base OOv3 0x2aBf…500c reads burnedBondPercentage 50%, USDC final fee 250 USDC, minimum bond 500 USDC, so option (b) needs the treasury sizing redone. Waits for the team to contact UMA and choose. Skipped: mainnet is out of hackathon scope (ADJ-51).

### X03 · Accounts, keys and Safes
- Owner: both
- PD: -
- Depends: O01.2
- Plan: §12.1, ADJ-38
- Cut: yes
- Status: done
- Files: oracle/deployments/params.monad-testnet.json
- Build: Every §12.1 role: hardware-wallet deployer; team Safe (2-of-3) and guardian Safe (2-of-3) on app.safe.global; three committee wallets; KMS secp256k1 runner attestor; watchdog key in a separate cloud account; two keeper/relayer EOAs; the sim relayer EOA (testnet only); fund each with testnet MON. The testnet bond token is the team TestUSDC (`seam-decisions.md` S-13).
- Done when: every address is in `params.monad-testnet.json` and no private key is in git.
- Check: manual: every §12.1 role has an address in oracle/deployments/params.monad-testnet.json
- Notes: Testnet custody per ADJ-38: every role is a hot key from `oracle/script/testnet_keys.py` in the git-ignored deployments/testnet-keys.env (no key in git: checked with `git ls-files` and grep). params.monad-testnet.json holds every §12.1 role address: deployer 0x676c…f49e, the lister standing in for the team Safe 0xcE81…95b1 (Timelock proposer, lister, sandbox owner), the guardian 0xbdB0…071d, committee 0x068e…, 0x179D…, 0xED10…, runner attestor 0xAdB4…86B0, watchdog 0x89F4…264C, keepers 0xCbf7…A85c and 0xB5E7…70eb, sim relayer 0x0f27…24C5 (each checked against the key file). Funded with testnet MON from the team's funded key (3-4 Oct 2026; keeper 2: 1 MON, tx 0xd838517c…4c19). The CRE org owner stays 0 until X01. Mainnet custody (hardware wallets, Safes, KMS, a separate watchdog account) is still required before OG4.

### X04 · Testnet deployment
- Owner: OA
- PD: -
- Depends: OG1, X03
- Plan: §12.4, §12.5, §12.11, §14.1, V-M3, V-C16, ADJ-18, ADJ-20
- Cut: yes
- Status: done
- Files: oracle/deployments/monad-testnet.json
- Build: The "OG1 deploy" that O23 waits for (ADJ-20). Re-verify every external address with `cast code`; run DeployUmaSandbox and DeployOracle; verify on the testnet explorer; queue and execute the §12.5 Timelock operations (sim forwarder, sim relayer, trust set 1 and its activation, globals version 1, providers, authRefs, treasury limits); fund the ASSERTION and WATCHDOG_FLOAT ledgers; list the first market and record `createMarket` gas (V-M3).
- Done when: `deployments/monad-testnet.json` holds every address, code hash, deploy block and Timelock operation, and the first market is listed.
- Check: manual: oracle/deployments/monad-testnet.json complete and the first MarketListed tx hash recorded
- Notes: Done 4 Oct 2026 on Monad testnet. The deployed runtimes match their recorded codehashes (keccak of `cast code`; this RPC has no `eth_getProof`, so `cast codehash` fails). Rehearsed first on an anvil 1.8.3 fork (Forge 1.8.3 refuses to fork an anvil 1.5.1 on chain 10143: `unknown monad hardfork Prague`). Live: the lister (team Safe stand-in, ADJ-38) proposed CreateTrustSet's two operations and the FundTreasury limits, keeper 1 executed them after the 300 s delay (execute gas 408,461 / 261,199 / 128,207): sim forwarder 0xB9F7…D192, sim relayer 0x0f27…24C5, trust set 1 active, globals version 1, statsapi.mlb.com, SPORTSDATA_V1, limits 100 USDC / 20 disputes; the deployer minted TestUSDC and deposited 1,000 USDC each into ASSERTION and WATCHDOG_FLOAT (broadcast/FundTreasury.s.sol/10143); the lister listed the O22.4 MLB pack unshifted (market 0xbb40…e5ea, engine 0x597C…21e9, T 8 Oct 2026 01:00 UTC), tx 0xee55d0c0…5a06, createMarket 4,149,249 gas (V-M3, in gas.json). Every hash is in deployments/monad-testnet.json (`timelockOps`, `markets`). The StubMarketFactory was not redeployed: the stub's error is `Unauthorized` on chain, `RiskUnauthorized` in the current source.

## External dependencies (other teams, plan §3.3)

| ID | Owner | What the oracle needs | Needed by |
| --- | --- | --- | --- |
| DEP-1 | Risk A+B | A concrete `MarketEngine` implementing `IResolutionEngine`, `IMarketConfig`, `RiskView` | O42 (OG3b) |
| DEP-2 | Shared (CP-FACTORY) | `MarketFactory.deployMarket(listing, engineInit)` per C.6, `onlyRegistry`, atomic | O42 (OG3b) |
| DEP-3 | Risk B | The oracle enum, the `Listing` fields and `voidSecs` = 45 days: decided by the oracle team in `seam-decisions.md` (ADJ-29) | re-checked in O42 |
| DEP-4 | Risk B | `RiskView.marketRiskView().monitorRestricted` on the production engine (relied on, `seam-decisions.md` S-09) | O14.5, re-checked in O42 |
| DEP-5 | App team | Indexer/frontend host for Disputes Live | O37.3, O38 |
