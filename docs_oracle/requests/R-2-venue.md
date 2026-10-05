# R-2: production assertion venue on Monad

Task X02. Plan §6.7 (options a and b), §16.2 R-2, §17, launch gate §12.10. The oracle state machine does
not change with the venue; only `IAssertionVenue` (the adapter) does.

Status: **open**. Facts below were checked on 4 Oct 2026; no venue is chosen and no message has been sent
to UMA / Risk Labs yet.

## Option (a): UMA deploys OOv3 on Monad

- UMA's network-address page lists OOv3 on Ethereum, Polygon, Optimism, Arbitrum, Base, Blast, Story and
  Avalanche (plus testnets). **Monad is not listed**
  ([docs.uma.xyz/resources/network-addresses](https://docs.uma.xyz/resources/network-addresses)).
- On chains without a native bridge to Ethereum, UMA relays disputes and DVM answers through "a multi-sig
  controlled by UMA core engineers at Risk Labs" (same page; Story and Avalanche work this way). A Monad
  deployment would most likely use that relay, which adds a trusted party to the dispute path.
- Needed from UMA: a timeline, the relay model, and USDC (`0x754704Bc059F8C67012fEd69BC8A327a5aafb603`)
  whitelisted as collateral with its final fee.

## Option (b): relay venue on Monad + OOv3 on Base over CCIP

- Base mainnet OOv3: `0x2aBf1Bd76655de80eDB3086114315Eec75AF500c` (UMA `packages/core/networks/8453.json`,
  same as the plan); Store `0xa799650614f84e0B7E7E99e12d5DFc241907cd85`. Base settles disputes fully
  permissionlessly (no multisig relay).
- CCIP: the Monad mainnet directory page lists an outbound **Monad → Base** lane, CCIP 2.0.0
  ([docs.chain.link/ccip/directory/mainnet/chain/monad-mainnet](https://docs.chain.link/ccip/directory/mainnet/chain/monad-mainnet));
  Monad chain selector `8481857512324358265`. Still to confirm: the Base → Monad direction (the page's
  "Inbound lanes" tab) and that the lane carries arbitrary messages, not only tokens.
- The relay adds its own trust and latency; `voidSecs` must cover the round trip (plan §6.7). A new
  `RelayVenue` and a Base-side asserter contract would need building and auditing.

### Base venue values, read on chain (Base block 52,162,519, 4 Oct 2026)

| Value | Result | Plan check |
| --- | --- | --- |
| `burnedBondPercentage()` | 0.5 (5e17) | V-U8: matches the assumed 50% |
| `Store.computeFinalFee(USDC)` | **250 USDC** (250,000,000 atoms) | V-U9 |
| `getMinimumBond(USDC)` | **500 USDC** | testnet is 2 USDC |
| `defaultLiveness()` | 7,200 s | markets set their own liveness |

**Economic consequence:** on Base every assertion needs a bond of at least 500 USDC
(`B = max(minBond, venue.minimumBond(), …)`, plan D9), against 2 USDC on testnet. Each listed market
commits at least 500 USDC of the ASSERTION ledger, and the watchdog float needs at least 500 USDC per
simultaneous dispute. The treasury sizing in plan §14 assumes a far smaller fee, so it has to be
redone before this option is chosen. A Monad OOv3 (option a) would have its own final fee, set by UMA.

## Draft message to UMA / Risk Labs

> Hi UMA team, we're building Eros Markets, a perpetual futures exchange for event markets on Monad.
> Every market resolves through a bonded assertion on UMA's Optimistic Oracle V3. Our contracts are
> live on Monad testnet against a sandboxed UMA stack, and we're planning a mainnet launch.
>
> 1. Is an OOv3 deployment on Monad mainnet planned, and if so, when?
> 2. Would disputes reach the DVM through the Risk Labs multisig relay, as on Story and Avalanche?
> 3. Could native USDC (0x754704Bc059F8C67012fEd69BC8A327a5aafb603) be whitelisted as collateral, and
>    what final fee would it carry?
> 4. If Monad isn't planned, would you support us asserting on Base's OOv3 through a CCIP relay?
>
> Our resolution contracts already integrate OOv3 behind a venue adapter, so a Monad deployment would
> drop straight in.

## Decision

Not made. X02 is done when a venue option is chosen with its expected date, or both are documented as
unavailable.
