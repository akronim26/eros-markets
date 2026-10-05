# Optional Privy signing and protection

Normal trading uses the selected Privy embedded or connected external wallet. The public App ID already in `frontend/.env.local` enables that flow. The Envio token in `oracle/indexer/.env` enables indexing. Neither is a server authorization key.

## What is implemented

- Selected embedded-wallet export via Privy's UI; MON balance and faucet link.
- User-reviewed, optional one-click order/cancel requests, authenticated with a Privy access token.
- Separately granted background protection: stop loss, take profit, scheduled cancel-all, margin/backing guards, and optional claim delivery.
- Exact policy verification, wallet ownership and revocation checks, block-pinned previews, gas estimates, durable request IDs and an activity journal.
- Manual reconciliation of an ambiguous signature using the original Privy reference and a confirmed chain receipt. Reconciliation makes no transaction request.

External wallets use ordinary wallet confirmations; their private keys are never available to the server.

## Configure before enabling

Use a persistent Node process with `node:sqlite` available (tested with Node 25.9). Run the frontend and worker from `frontend/`, sharing one durable local SQLite file. This implementation is for one host; separate serverless instances with separate disks cannot coordinate requests or rules.

1. Generate review files with `npm run privy:policies`. Review `frontend/privy-policies/eros-trade.json` and `eros-protect.json`. This command does not create policies in Privy.
2. In the existing Privy app, create separate authorization keys, signer quorums and immutable policies for trading and protection. Configure the blank server-only entries in `frontend/.env.example` locally. Never expose them using a `NEXT_PUBLIC_` variable.
3. Verify the policies in Privy using an isolated test wallet: allow the listed engine methods; reject transfers, other engines/chains, arbitrary signing, and a protection order with `reduceOnly=false`. The decoded tuple restriction must be tested against real Privy enforcement before enabling protection. Local SDK doubles establish application checks only.
4. Run `npm run automation` in `frontend/`. Keep the worker supervised and the SQLite file on persistent storage. Keep the database private and back it up using SQLite's backup facility (including active WAL data).
5. Log in, select the embedded wallet, open Trading permissions and explicitly grant the desired signer. The app verifies the remote policy before offering a grant. Users can revoke all additional signers from this panel.

The optional claim payer pays MON only for `claimTrader(owner)` on allowlisted engines; assets are paid to the owner. Leave `CLAIM_DELIVERY_PRIVATE_KEY` blank to disable it. Credentials, policy setup, user grants and real delegated signing have **not** been completed for this environment.

## Execution and recovery

Price rules use the engine mark. IOC reductions can fill partially or not at all. A rule never repeats its transaction to chase remaining size; inspect the result before creating a replacement. Rules stop when the position is flat/reversed, the market halts, or the rule expires. A running worker and network availability are required.

`requests` in SQLite records a stable request/reference ID, wallet ID, intent digest, state and known hash. An uncertain signing response pauses further server sends for that wallet. Do not delete the row or change it back to active. Find the original transaction in Privy's dashboard/logs and run:

```sh
# From frontend/, using the same .env.local and AUTOMATION_DB as the server:
npm run automation:reconcile -- REQUEST_ID PRIVY_TRANSACTION_ID
```

This checks Privy's reference ID, wallet and chain and requires a terminal Privy status and RPC receipt before releasing the wallet. If Privy cannot establish the original result, the pause remains. Normal wallet signing remains available, but the user must inspect pending wallet activity first.

After a worker crash, a rule in `sending` or `uncertain` is never automatically replayed. Inspect its journal/hash and the wallet's activity; reconcile the related request as above when possible. The original rule stays stopped. Create a replacement only after establishing the original transaction's outcome. A confirmed empty IOC is completed, not retried. Existing grants can be revoked from the wallet panel even when the signing service is disabled.

## Checks

```sh
cd frontend
npm run typecheck
npm test
npm run test:integration
npm run build
```

Server integration tests use SDK/RPC doubles. They are not evidence of live Privy policy enforcement, authenticated browser trading, or production uptime.
