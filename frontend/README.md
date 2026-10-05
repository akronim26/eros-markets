# Eros Markets frontend

## Run locally

Copy `.env.example` to `.env.local`, set the public `NEXT_PUBLIC_PRIVY_APP_ID`, then run `npm run dev` from this directory. Configure email, Google and wallet login in the Privy dashboard, and allow the localhost/deployed origins used by this app. Restart the dev server (or rebuild production) after changing public environment variables. Never put a Privy app secret in the frontend.

Without an App ID, public market data remains available and wallet actions are disabled.

For a production preview on port 3100, stop any running `next start` process, run `npm run build -- --webpack`, then run `npm run start -- -p 3100`. Restart the server after every production rebuild: a running server can retain old HTML that references CSS/JS files replaced by the new build, leaving the page unstyled.

## Wallet flow

- **New users:** Privy login with email/Google creates an Ethereum embedded wallet when the user has no wallet.
- **Existing wallet users:** Choose wallet login in Privy's modal and authenticate the external wallet.
- **Both on one account:** Open the address button in the header. Connect another existing wallet or create a Privy wallet, then select the wallet to trade from. Creating a wallet does not transfer funds or positions from another address.
- **Trading:** Privy's wagmi integration supplies the selected wallet to the existing viem/wagmi contract flow: collateral approval, deposit, allocation and order placement. Simulation and explicit gas estimation happen before each wallet signature.
- **Network:** Monad testnet (10143). The wallet menu offers network switching. Each trading wallet needs testnet MON for gas and the deployment's test collateral, supplied by the testnet operator.

The frontend scopes balances to the selected address and pins writes to its account, connector and chain. Changing the wallet, network or login session stops the remaining steps of a transaction sequence. An already submitted transaction can still execute; check the explorer and balances before retrying a partially completed funding sequence.

## Appearance

Use the theme icon in the header to select **Light**, **Dark**, or **System** (the default). The choice is stored locally and synchronized across tabs. System follows device appearance changes. A small script applies the saved palette before the page paints, and theme changes update the existing page and Privy provider without remounting them. Colors, logos, charts and wallet dialogs share the theme; reduced-motion settings disable the theme fade and the diagrams' ambient animation.

The landing page's oracle illustration uses local SVG and CSS, with no video download or animation dependency. It cycles through the three architectural layers; hover, keyboard focus or touch selection lets visitors inspect a layer. The pause control stops motion, and both diagrams pause when offscreen or when the tab is hidden. Reduced motion keeps the illustration static while retaining manual layer selection. This illustration does not represent live oracle activity.

## Verification and demo

```sh
npm run typecheck
npm test
npm run build -- --webpack
```

The automated tests exercise transaction sequencing, account/network changes, logout, rejected wallet requests and tracking a transaction submitted during a switch. They do not replace a live wallet test.

For the Privy bounty demo:

1. Log in using email/Google with a new account and show the created Privy wallet.
2. Fund that address with test MON and test collateral. Show approval, deposit and allocation using its Privy confirmation prompts and explorer receipts.
3. Place an order on an active, funded market and show the receipt and resulting position/order.
4. Connect an existing wallet from the wallet menu. Switch between the two addresses and show their separate balances and positions.
5. Reload to check session restoration, then log out to check that account data disappears. Test a rejected signature and wrong-network recovery too.

Wallet creation and actual embedded-wallet contract signing demonstrate Privy beyond authentication. Wallet export is available for the selected embedded wallet. Optional one-click trading and background protection are implemented but remain disabled until server credentials, separate policies/signers and a supervised worker are configured; see [automation setup](../services/automation/README.md). Gas sponsorship is not implemented. Full transaction verification requires funded wallets and a market that permits trading.

References: [Privy wallet onboarding](https://docs.privy.io/wallets/connectors/usage/connect-or-create), [Privy wagmi wallet selection example](https://docs.privy.io/recipes/lens).
