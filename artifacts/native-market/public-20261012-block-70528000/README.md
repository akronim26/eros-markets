# Native market resolved early on Monad testnet: block 70,528,000 (public)

- Date: 2026-10-12 23:12–23:35 UTC, chain **10143**. Source revision: `feat/native-market` (`f9b471c` for the resolution script).
- **Event:** "Will Monad testnet reach block 70,528,000 before 01:00 UTC on 14 October 2026?"
  - T = 1791939600, more than 24 h after listing, as the engine requires.
  - The rules ([params.json](params.json)) allow **early YES** once the block exists.
  - Evidence: block 70,528,000 was finalized at 2026-10-12T23:26:32Z with hash `0x00d5d71a406e2747438870b974b6dcd0de1d27163cd2bbfd3c406fe6197d4503`.
- **Labels:**
  - test collateral;
  - team-controlled liquidity;
  - outcome decided through the existing committee route with the **sandbox** UMA venue (owner-controlled). This is not a decentralized oracle result.

| Item | Address |
| --- | --- |
| marketId | `0x22cb2264312f272ba210a723ab35fc40321138150472de502e8135b80df7c9ff` |
| NativeOutcomeVault | `0x1a5beFf18ABe197277D3dca6fBfF1C8e670cB2A0` |
| Kuru YES / NO books | `0x31bFeF909F7F9359FF4dD82271E310a3477B79CC` / `0x72659CaA2b91f375a76424A0eA6679ED586f6Da0` |
| Engine | `0x90E522cBfBB038A91c23dB825102980c4417A84c` |
| ResolutionOracle (existing) | `0xb86a48B07eE07037F1B52273B9B50f20615B61e4` |

| Step | Tx (status 1) |
| --- | --- |
| Deploy vault, YES/NO, books | [deploy-receipts.json](deploy-receipts.json) |
| `createMarket` + `bindMarket` (gas multiplier 1.05) | [list-receipts.json](list-receipts.json) |
| Timelock execute `activateMarket` | `0xd1a0b06711291046efa43a32440ed30e8309daab43f0d860b235fada092c9b5e` |
| Trader buys 20 YES @0.90 and 20 NO @0.15 on Kuru | `0x67589d3b…7f86`, `0xaed8b624…8b55` |
| Monitor `requestReduceOnly`, `requestEarlyCheck`; attestor panel result; 2-of-3 committee YES proposal; `assertProposal` | `0x8610cbaf…2bf1`, `0xc6e4d965…a0b0`, `0xf2b640e3…6702`, `0x359d186e…00e4`, `0xa7295702…5750` (assertion `0xc0f786c3…260f`, asserted 23:28:09Z) |
| `finalizeMarket` after 300 s liveness → oracle Final/YES; engine `finalOutcome = YES`, halted | `0xca8faf4794982dc75b86a7b736caef34178cbf52d0a98812eccf6444da905865` (23:33:54Z) |
| Vault `syncResolution` → `payoutYesWad = 1e18` | `0xe5adc6d2e0b71fe60d4c9913701be539563be9398aec298d3b77b5c354a8caab` |
| Trader withdraws from Kuru, `redeem(20 YES, 20 NO)` → **+20 tUSDC** (879.6 → 899.6); YES = NO = 0 after | `0x58692cfd137d40f5ed7d29e04191fc046a1866320513e473f77a94fce3d532f5` |

The trader's spot P&L: 18 + 3 spent, 20 redeemed, so −1 tUSDC, as expected.

Two finalize attempts before the liveness ended correctly left the assertion pending (state 7). Only one finalize transaction was mined, after liveness.
