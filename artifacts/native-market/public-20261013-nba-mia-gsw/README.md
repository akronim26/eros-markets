# Public native market: Miami Heat at Golden State Warriors (NBA, 5 Nov 2026 PT)

- Chain: Monad testnet (10143). Deployed and activated 2026-10-13 from the registry lister `0xFf49…F190`.
- Event: Miami Heat (away) at Golden State Warriors (home), NBA 2026-27 regular season, Chase Center.
  Tip-off `2026-11-06T03:00:00Z` (7:00 p.m. PT, 5 Nov), ESPN game `401909937` (ESPN schedule API, checked 2026-10-13).
  YES = Warriors win (incl. overtime); NO = Heat win; INVALID if not completed by 2026-11-08T03:00Z. Eros halts at tip-off (T = 1793934000).
- Market id `0xe4cdb8ad98dc522e861988c3349499e6b8e851ff8b0900e3127e4374c4651f4d` (`keccak("eros-native:nba-mia-gsw-20261105")`).

| Contract | Address |
| --- | --- |
| Engine | `0x263dBdC3B86732b81F616850F51d41cc3362aEcE` (listed block 70643830, bound 70643837) |
| NativeOutcomeVault | `0xb80e0cEE9be3f24d7685C11DC1c14846942913af` |
| eGSW-YES / eGSW-NO | `0xed48Bf7370263A27AE49Cb39701239f4D87048e8` / `0x12440B1645f1D6D0Aeb5BE3ccc4d4D80D737be8E` |
| Kuru YES / NO book | `0x9f7A2191BB373184d81b0b8d80220aD05Eb2fc90` / `0x57E03F404c6c30863dCe250D3BD651aEc88aDD7d` |
| INDEX signer (pinned) | `0x2174Ef0C7c96E908A06A4DB51AB235A35756b105` (new, market-specific) |
| Monitor | `0x249C5358f353754d3829e21237edA22E6340475a` · governance: Timelock `0x9fe0…11F5` |

- Activation: Timelock propose `0x2c9f138edb4ddf0841ec195b1157ec976cc938b80eb293c094d0d66990ae1a26`, execute `0x0d71b3ca495d331e1d835d0a37445d0d3de2dc9967b36ca7ec19d2d02da42b8d`; `active() = true`.
- Rehearsed first on a local fork with the same parameters (deploy, rules, list, Timelock activation): all passed.
- `verify.txt`: read-only `native-verify` run after activation.
- Not yet running: INDEX publisher, keeper, spot maker (workers/observation architecture to be decided). Until then INDEX/MARK are unavailable and the Kuru books are empty.
