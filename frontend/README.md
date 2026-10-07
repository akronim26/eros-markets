# Eros Markets frontend

## Run locally

The frontend selects the verified **2026-10-07 integrated Monad testnet deployment**
in `src/config/public-manifest.json`. It includes the factory, shared collateral
vault and two Polymarket event engines. Previous manifests are retained in
`src/config/archived-deployments.json` so each existing owner's balances and custody
transactions remain bound to the original vault. The address/receipt inventory and service
activation instructions are in [DEPLOYMENT_PROGRESS.md](../docs/integration/DEPLOYMENT_PROGRESS.md).
The old manual fixture is historical. Never copy local chain addresses into this manifest.

Run `npm ci` first. The browser SDK is installed from `../oracle/packages/oracle-sdk`;
keep that directory in frontend build checkouts. `.npmrc` packs this local dependency
so a separate Bun workspace install is not needed to build the frontend.

Copy `.env.example` to `.env.local`, set the public `NEXT_PUBLIC_PRIVY_APP_ID`, then run `npm run dev` from this directory. Configure email, Google and wallet login in the Privy dashboard, and allow the localhost/deployed origins used by this app. Restart the dev server (or rebuild production) after changing public environment variables. Never put a Privy app secret in the frontend.

For a sponsored RPC with an access token in its URL, set
`NEXT_PUBLIC_READ_RPC_URL=/api/rpc` and put the full endpoint in the **server-only**
`MONAD_RPC_URL`. Keep `NEXT_PUBLIC_RPC_URL` credential-free for wallet network
configuration. The proxy accepts bounded read/simulation requests, strips upstream
error messages, and refuses transaction submission and signing methods. Restart
the server after changing the private endpoint; rebuild after changing public settings.

Index and mark prices come from the verified engine. The Polymarket publisher,
funded book makers, sampler and epoch operator must run continuously. A successful
source fetch alone does not establish an on-chain price: INDEX needs 300 seconds
of complete coverage; the mark also needs PERP60/BASIS900 coverage and the normal
pricing transition at an epoch opening. The UI keeps these values unavailable
until those contract checks pass.

The terminal chart shows authenticated Polymarket source observations over time;
the execution INDEX is their 300-second TWAP. Live/1H/6H/1D/All controls, pointer
inspection and keyboard arrows inspect recorded observations. Invalid observations
and gaps longer than 30 seconds break the plotted line. The optional dashed line
is the current MARK, not reconstructed historical marks. Order-book sizes are gross
resting claims and may contain stale orders; exact contract previews and fill events
determine executable orders. Clicking a book price prefills the ticket without signing.

Without an App ID, public market data remains available and wallet actions are disabled.
If browser storage is blocked, public pages remain available and the wallet button
explains how to restore login. Privy's SDK is loaded only after this check.

For a production preview on port 3100, stop any running `next start` process, run `npm run build -- --webpack`, then run `npm run start -- -p 3100`. Restart the server after every production rebuild: a running server can retain old HTML that references CSS/JS files replaced by the new build, leaving the page unstyled.

## Wallet flow

- **New users:** Privy login with email/Google creates an Ethereum embedded wallet when the user has no wallet.
- **Existing wallet users:** Choose wallet login in Privy's modal and authenticate the external wallet.
- **Both on one account:** Open the address button in the header. Connect another existing wallet or create a Privy wallet, then select the wallet to trade from. Creating a wallet does not transfer funds or positions from another address.
- **Trading:** Privy's wagmi integration supplies the selected wallet to the existing viem/wagmi contract flow: collateral approval, deposit, allocation and order placement. Simulation and explicit gas estimation happen before each wallet signature.
- **Network:** Monad testnet (10143). The wallet menu offers network switching. Each trading wallet needs testnet MON for gas. The account panel offers 1,000 free test collateral tokens when the wallet and free vault balance are empty; minting still requires wallet confirmation and gas.

The frontend scopes balances to the selected address and pins writes to its account, connector and chain. Changing the wallet, network or login session stops the remaining steps of a transaction sequence. An already submitted transaction can still execute; check the explorer and balances before retrying a partially completed funding sequence.
Only one owner transaction sequence can run per wallet and chain in a browser tab,
including sequences started from different terminal panels. Failed receipt checks
retain the submitted transaction's explorer link.

Owner calls use the browser SDK transaction builders. Simulation and estimation use
one block; dependent calls wait for the exact canonical finalized receipt. Public
reads check chain, runtime hashes, listing identities and factory/vault/oracle bindings.
Optional server trading and protection also verify this deployment before signing.
Deployless multicalls avoid requiring a Multicall3 deployment. Long/short leverage
limits come from `leverageCaps()`; the 5× ceiling does not promise current availability.
The optional margin lens only uses the included synthetic parameters after matching
their canonical on-chain profile hash.

The markets page exposes trading terminals only for engines in the verified public
manifest. Registry/indexer discovery does not grant a newly listed engine permission
to use owner transaction builders; verify and update the manifest first.

History remains unavailable until a matching indexer is running. Set both
`NEXT_PUBLIC_INDEXER_URL` and
`NEXT_PUBLIC_INDEXER_DEPLOYMENT=10143:0x780e73ddc65113f8c9c506daa25a0404ed9f3e33`.
An old endpoint without this binding is ignored. Current state still comes from RPC.

To regenerate ABIs, compile the oracle with its pinned integration profile and
compile `contracts/src/lens/MarginLens.sol`, then run `npm run gen:abis` here.
Generated ABIs are committed so CI does not require Solidity compilation for a
frontend-only build.

## Appearance

Use the theme icon in the header to select **Light**, **Dark**, or **System** (the default). The choice is stored locally and synchronized across tabs. System follows device appearance changes. A small script applies the saved palette before the page paints, and theme changes update the existing page and Privy provider without remounting them. Colors, logos, charts and wallet dialogs share the theme; reduced-motion settings disable the theme fade and the diagrams' ambient animation.

The landing page's oracle illustration uses local SVG and CSS, with no video download or animation dependency. It cycles through the three architectural layers; hover, keyboard focus or touch selection lets visitors inspect a layer. The pause control stops motion, and both diagrams pause when offscreen or when the tab is hidden. Reduced motion keeps the illustration static while retaining manual layer selection. This illustration does not represent live oracle activity.

## Verification and demo

```sh
npm run typecheck
npm test
npm run test:integration
npm run build -- --webpack
```

The automated tests exercise transaction sequencing, account/network changes, logout, rejected wallet requests and tracking a transaction submitted during a switch. They do not replace a live wallet test.

The storage-restriction browser regression can be run separately against a running
production preview with a configured public Privy App ID. Start Chrome with a
dedicated profile and `--remote-debugging-port=9232`, then run
`node scripts/check-browser-storage.mjs http://localhost:3100 9232`. It creates
and closes its own tab, blocks storage, checks the public UI and restores storage;
it does not authenticate or send transactions.

For the Privy bounty demo:

1. Log in using email/Google with a new account and show the created Privy wallet.
2. Fund that address with test MON and test collateral. Show approval, deposit and allocation using its Privy confirmation prompts and explorer receipts.
3. Place an order on an active, funded market and show the receipt and resulting position/order.
4. Connect an existing wallet from the wallet menu. Switch between the two addresses and show their separate balances and positions.
5. Reload to check session restoration, then log out to check that account data disappears. Test a rejected signature and wrong-network recovery too.

Wallet creation and actual embedded-wallet contract signing demonstrate Privy beyond authentication. Wallet export is available for the selected embedded wallet. Optional one-click trading and background protection are implemented but remain disabled until server credentials, separate policies/signers and a supervised worker are configured; see [automation setup](../services/automation/README.md). Gas sponsorship is not implemented. Full transaction verification requires funded wallets and a market that permits trading.

References: [Privy wallet onboarding](https://docs.privy.io/wallets/connectors/usage/connect-or-create), [Privy wagmi wallet selection example](https://docs.privy.io/recipes/lens).
