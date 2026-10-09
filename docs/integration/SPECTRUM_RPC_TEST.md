# Spectrum Monad testnet RPC check — 6 October 2026

## Result

The endpoint is a usable candidate for Monad testnet reads, but these short checks
do not certify continuous publisher operation or establish its maximum capacity.
No HTTP/RPC rate-limit response was observed. Latency and large response delivery
need attention before relying on it for the continuous price service.

No transactions were signed or broadcast. The credential is stored only in ignored
`tmp/spectrum-rpc.env`, mode 0600. Active service and frontend RPC configuration was
not changed by this test.

## Measured load

No automatic retries were used. Each load request had a five-second end-to-end
timeout, including reading the response body. The mixture included finalized
blocks, market risk/source/depth/cap reads, pending nonces, balances, receipts,
100-block log ranges, and gas prices.

| Phase | Requests | Success | Successful-request p95 |
| --- | ---: | ---: | ---: |
| 5 requests/second, 10 seconds | 50 | 50 | 862 ms |
| 10 requests/second, 15 seconds | 150 | 149 | 1,329 ms |
| 5 requests/second, 60 seconds | 300 | 300 | 835 ms |

The failure at 10 requests/second was a receipt request that timed out. It was not
a 429 response. The ramp stopped there; 20, 40 and 80 requests/second were not
tested. Thus 5 requests/second is the highest clean rate measured in this run,
not a claimed provider limit. The 10 requests/second phase achieved 9.06 completed
requests/second including drain time. Finalized head ages during load ranged from
0.70 to 4.05 seconds.

## Compatibility

- Chain ID 10143 and a fresh finalized head passed.
- The original deployment verification block/hash remained available.
- Listing identity, listing hash and live market risk reads passed.
- Historical state at the deployment verification block passed despite the
  endpoint's `pruned` label; this is not a guarantee of unlimited archive retention.
- The real wallet's earlier funding receipt and its canonical block passed.
- State reads at 10, 100 and 1,000 blocks behind the sampled head passed.
- Deployless multicall, HTTP batches of 3 and 10 requests, and log queries over
  100 and 1,000 blocks passed.
- The sampler's pending simulation and gas estimate passed without broadcasting.
- The actual pricefeed `preflightMonadTestnet` returned `ENGINE_PINS_VERIFIED` in
  18.368 seconds.

## Large response concern

Two initial compatibility runs stopped at five-second contract-code timeouts.
In the subsequent run, a sweep of deployed runtime hashes reached the engine
but its code response timed out even with a separate 20-second budget. Earlier
contracts in that sweep matched their expected runtime hashes.

Two isolated engine-code reads then completed in 7.746 and 12.729 seconds and
matched the expected hash. Both delivered the same uncompressed 244,444-byte JSON
response. A public control endpoint delivered the same verified code using gzip
in 1.963 seconds. This comparison identifies an observed response-delivery issue;
it does not isolate the cause to the provider rather than the network route.

The actual publisher preflight passed, but its 18-second runtime is material to
the pricefeed's short freshness budget. Repeated service-level operation and
recovery still need to pass before migration is called complete. No freshness,
identity or finality checks were relaxed.

## Evidence and reproduction

- Main report: `tmp/rpc-pressure-2026-10-06T14-53-18-090Z/report.json`
- Per-request metrics: `samples.jsonl` in that directory
- Large-code comparison: `large-code-diagnostic.json`
- Actual publisher preflight and HTTP batches: `service-compatibility.json`
- Earlier failures remain in `tmp/rpc-pressure-2026-10-06T14-51-44-637Z/` and
  `tmp/rpc-pressure-2026-10-06T14-52-15-769Z/`.

Run with Node 22.23.3+ and the existing frontend dependencies installed:

```sh
node scripts/e2e/rpc-pressure.mjs /path/to/private-rpc.env \
  "<owner-public-address>" "<sampler-sender-public-address>"
```

Replace both address placeholders with the intended current deployment's public
owner and sampler sender addresses. The script no longer assumes historical
operator identities; no private key is an argument.

The private file supplies `MONAD_TESTNET_RPC`. Reports retain only its hostname and
SHA-256 fingerprint, not the authenticated URL. The main report contains 541 RPC
requests, including compatibility checks and 500 load requests. Separate initial
and diagnostic checks are additional requests and are retained separately.
