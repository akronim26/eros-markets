# CP-PRICE wire contract: technical confirmation

Checked 03 October 2026 against repository HEAD
`08095a802ec503dfd24eea2e0acc253d11db7742` (including risk commit `16f0d90`).
This records implemented compatibility, not human gate acceptance, production
authority or approval of Polymarket-specific policies. Owner/reviewer acceptance
remains unrecorded; no risk-side status or assumption file is changed.

## Existing contract implemented by this package

Authoritative sources are `contracts/src/interfaces/IPriceSource.sol` and
`contracts/src/pricing/PriceIngress.sol` at the repository root. The package's
`src/wire.ts` implements their existing protocol without changing counterpart code.

Call: `submitObservation(Observation obs, bytes signature)`.

| Order | Field | Solidity type |
|---|---|---|
| 1 | marketId | bytes32 |
| 2 | sourceId | bytes32 |
| 3 | sequence | uint64 |
| 4 | observedAt | uint64 |
| 5 | publishedAt | uint64 |
| 6 | priceWad | uint256 |
| 7 | impactBidWad | uint256 |
| 8 | impactAskWad | uint256 |
| 9 | bidDepthLots | uint256 |
| 10 | askDepthLots | uint256 |
| 11 | sourceRulesHash | bytes32 |

Prices use WAD (1e18 = 1.0); times use Unix seconds; depth uses lots
(1 lot = 0.001 claim). Signatures bind every input field, the chain ID and the
destination engine address using raw
`keccak256(abi.encode(TYPEHASH, fields..., chainId, engine))`.
The exact one-line type string in `src/wire.ts` matches `PriceIngress.sol`.
No personal-message prefix, EIP-712 wrapper or packed encoding is used.

The engine requires matching market/source/rules/signer pins, increasing sequence,
nondecreasing source time and `observedAt <= publishedAt <= acceptedAt`.
For valid depth, both sides cover N, `0 < bid <= ask < 1e18`, spread is within
the listing bound, and signed midpoint is `floor((bid + ask) / 2)`.
Engine-generated `acceptedAt`, `depthValid` and `payloadDigest` are event outputs,
not tuple fields. Risk owns TWAP, mark and economic decisions.

## Evidence and remaining agreement

`npm run check:wire` exited 0 on 03 October 2026, comparing the eleven fields,
type string and raw encoding order to current risk code. Previously recorded
local evidence includes four real-ingress/store tests and 36 of 36 live-source
observations accepted on an owned local chain; that completed demo is retained
in `artifacts/demo/latest.json`. No new local chain run was performed for this
confirmation record.

I-3 requests CP-PRICE confirmation of this already-defined envelope. This document
provides its technical basis. Named counterpart acceptance is separate and is not
invented here. The user subsequently selected before-fee VWAP, directed price
rounding and validated two-sided displayed depth with floor-total lots. See
`impact-decision.md`. Provider-time meaning, quote normalization/provider precision,
canonical rules hash and operational invalid policy remain open under Q03-Q10.
