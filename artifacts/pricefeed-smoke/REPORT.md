# Polymarket public data smoke check

**PUBLIC_DATA_FETCH_PASS**: three categories, six real CLOB snapshots; all six returned HTTP 200. No risk engine delivery was attempted.

Captured on 2 October 2026. Exact decimal/rational calculations use Python Fraction; no floating-point financial math.

## Latest captured quotes

| Category | Question / selected outcome | Best bid | Best ask | Quote midpoint | Source age at capture |
|---|---|---:|---:|---:|---:|
| crypto | [Will Bitcoin reach $87,500 in October?](https://polymarket.com/event/what-price-will-bitcoin-hit-in-october-2026) / **Yes** | 0.79 | 0.8 | 0.795 | 2.105 s |
| sports | [China Open: Yunchaokete Bu vs Novak Djokovic](https://polymarket.com/event/atp-bu-djokovi-2026-10-01) / **Novak Djokovic** | 0.9 | 0.91 | 0.905 | 0.393 s |
| politics | [Will Flávio Bolsonaro win the 2026 Brazilian presidential election?](https://polymarket.com/event/brazil-presidential-election) / **Yes** | 0.552 | 0.553 | 0.5525 | 9.423 s |

Prices are quoted per selected outcome claim. A quote midpoint is distinct from the depth-N impact midpoint and the engine's 300-second index.

## Validation and depth demonstration

Each snapshot passed condition/token identity, active/open/accepting-order metadata, exact decimal and tick-grid parsing, nonempty uncrossed books, and minimum-order-size checks. Bids were sorted descending and asks ascending; duplicate levels were aggregated. Depth quantities were converted conservatively to lots (1 claim = 1,000 lots).

Illustrative settings only: N = 1,000 claims (1,000,000 lots), maximum absolute spread = 0.05. Both proposed VWAP and alternative marginal-level results are stored. The VWAP bid rounds down, ask rounds up and midpoint rounds down. These calculations do not approve a production pricing policy or fee/collateral normalization.

| Category | Example VWAP impact bid | Example VWAP impact ask | Example depth midpoint | Bid depth (lots) | Ask depth (lots) | Example depth check |
|---|---:|---:|---:|---:|---:|---|
| crypto | 0.79 | 0.8 | 0.795 | 382280670 | 59173810 | PASS |
| sports | 0.89005 | 0.917878 | 0.903964 | 475459760 | 67815350 | PASS |
| politics | 0.55148738 | 0.553 | 0.55224369 | 4474423690 | 12872144790 | PASS |

## Freshness and limits

All six reported source timestamps were within 30 seconds at capture and advanced on the second read. Local file-write timestamps approximate receipt; source times are preserved without retimestamping. The source-time gaps between the two reads exceeded 30 seconds, so this run contains coverage gaps and cannot produce the required continuous 300-second risk index.

The risk engine needs an independent outcome-book reference for bootstrap, margin/mark validation, funding and INVALID history. It owns TWAP aggregation and freshness guards. Public API access works, but event equivalence, impact/time policy, production N/spread, signer/domain and actual signed ingress remain unverified.

## Evidence and reproduction

- `raw/`: unmodified Gamma tags/event pages/selected metadata, full CLOB books and HTTP headers.
- `selected-markets.json`: exact outcome mapping, condition IDs, token IDs and request URLs.
- `capture-times.json`: preserved original file-write timestamps.
- `summary.json`: all six results, both impact methods, timestamp gaps and evidence SHA-256 hashes.
- Recompute offline: `python3 artifacts/pricefeed-smoke/analyze.py`.
- Refetch a chosen token: `curl --fail --silent --show-error 'https://clob.polymarket.com/book?token_id=<tokenId from selected-markets.json>'`.

## Work record

Read CLAUDE.md, the implementation PDF, risk specification pricing/units/lifecycle/configuration/math-first sections, price-source ABI, CP-PRICE request and current STATUS. Used official Polymarket discovery and order-book documentation. Category tag IDs were fetched (crypto 21, sports 1, politics 2). Public requests used bounded retries; initial DNS failure inside the sandbox required network escalation, and some requests retried connection resets.

Commands: escalated `git fetch` exit 0; Gamma discovery and all six final book requests exit 0; PDF extraction exit 0; offline analyzer exit 0. Risk gates were not run because no contracts or risk behavior changed. The existing `pricefeed` branch and pre-existing untracked files were preserved. Added only this diagnostic evidence directory; no commit, push or shared risk STATUS change.

Next step: a bounded continuous collection run to measure coverage and latency, then resolve source-time/impact semantics before signing integration.
