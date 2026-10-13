# Frontend audit — 6 October 2026

Baseline: `8c73266` on `feat/pricefeed`. User requested a frontend bug and
completion audit. This is technical validation, not an independent security audit.

## Progress

- [x] Map routes, wallet sessions, orders, funding/claims, discovery, history,
  oracle actions, reserve tools, protection, themes and landing interactions.
- [x] Baseline: TypeScript, 28 unit tests and 7 server integration tests pass.
- [x] Baseline Chrome: public routes and nine terminal panels load without runtime
  errors or failed responses.
- [x] Reproduce chart faults and implement fixes with regression tests.
- [x] Repair loading/error states and contract-versus-network error handling.
- [x] Correct animated text accessibility and terminal keyboard selection.
- [x] Add frontend CI; existing workflows did not check frontend-only pushes.
- [x] Clean install, production build and final automated checks.
- [x] Repeat browser, responsive, accessibility, network recovery and theme checks.
- [x] Record final evidence and external dependencies.

## Findings and repairs

| Finding | Effect | Repair |
|---|---|---|
| Depth width clamped before scaling | Every nonzero bar appeared equally full | Scale first, then apply the two-pixel minimum |
| Depth sampled only around the spread midpoint | Wide spreads hid both actual touches | Read a bounded set of ticks outward from each touch |
| Empty-book query retained previous results | Cancelled liquidity could remain visible | Clear depth when both touches become zero; distinguish loading/failure from empty |
| Market verification swallowed every exception | RPC outages could masquerade as missing-market 404s | Preserve transport failures and provide a retry boundary; deduplicate metadata/page reads |
| Upkeep/oracle simulation swallowed network errors | Failed checks could appear to mean no available action | Only treat contract reverts as rejected actions |
| Missing balance snapshots labelled “not funded” | Loading or failed reads misrepresented account state | Distinct loading/unavailable states and retries on list/portfolio views |
| Cancel-all depended on successful order discovery | A history/log outage blocked the account-wide escape action | Allow cancel-all for a known trader; retain transaction simulation and wallet guards |
| Animated text used prohibited labels on generic spans | Screen readers could miss headings and values | Provide stable screen-reader text separately from the animation |
| Terminal tabs lacked keyboard selection and panel relationships | Arrow-key navigation did not work | Roving focus, arrow/Home/End controls and labelled panels |
| No frontend CI workflow | Frontend-only pushes bypassed all app checks | Frozen install, unit/server tests and production build with built-in TypeScript checks |
| Vulnerable transitive `ws` 8.x versions | Dependency audit reported one high-severity advisory | Override ws 8.x to patched 8.21.3; dependency audit remains available locally |

## Dependency follow-up

`npm audit` originally reported 25 affected package entries (24 moderate, one
high). The WebSocket patch reduces this to **23 moderate, zero high/critical**.
The remaining entries trace to two advisories in the legacy wallet stack pulled
in through Privy's `x402` dependency:

- [decode-uri-component malformed-input CPU exhaustion](https://github.com/advisories/GHSA-vcc3-ghjq-m6fr):
  the patched 0.5.0 is ESM-only; the installed `query-string` 7.x consumer expects
  a CommonJS function. A blind override changes the module API.
- [uuid buffer bounds validation](https://github.com/advisories/GHSA-w5hq-g745-h8pq):
  the patch starts at 11.1.1, while legacy MetaMask packages request 8.x/9.x.
  This needs a tested wallet-stack upgrade, including authenticated connections.

The fixed WebSocket advisory is documented by the
[ws maintainers](https://github.com/websockets/ws/security/advisories/GHSA-96hv-2xvq-fx4p).
These package reports are not proof of an exploitable application path, and the
remaining advisories have not been dismissed as harmless. Recheck and upgrade the
inherited wallet dependencies before a production release.

## Verification limits

No public-chain write, deployment, real wallet login, delegated signature or policy
change is part of this audit. The active fixture still needs operator activation,
test collateral, fresh INDEX observations and matching liquidity for a live demo.
Live leverage needs approved calibration; optional Privy automation needs its
server credentials, policies and worker. Hosted history needs a publicly reachable
HTTPS endpoint. These are tracked separately from browser/code defects.

## Final verification

| Check | Result |
|---|---|
| Clean temporary checkout: `npm ci`, unit/integration tests, webpack production build, typecheck | Exit 0; public credentials omitted for this build |
| Final working tree: `npm ci` | Exit 0; patched dependency lock installed |
| `npm test` | Exit 0; **31 passed**, zero failed/skipped |
| `npm run test:integration` | Exit 0; **10 passed**, zero failed/skipped; RPC/SDK doubles are explicit |
| `npm run build -- --webpack` | Exit 0; upstream optional connector/dynamic-import warnings remain |
| `npm run typecheck` | Exit 0 |
| `npm audit --audit-level=high` | Exit 0; 23 moderate, zero high/critical |
| Chrome responsive checks | **50 passes**: five public routes × light/dark × 320/390/768/1024/1440 px; no horizontal overflow |
| axe-core 4.10.3, WCAG 2 A/AA + 2.1 AA rules | **Zero violations** across the five routes in both themes; this is automated coverage, not complete accessibility certification |
| Browser runtime/network on normal routes | Zero JavaScript exceptions and zero failed HTTP responses |
| Terminal | All nine panels load; Home/ArrowRight navigation selects and focuses tabs; All markets returns to the list |
| Theme/motion | System follows OS changes; reduced motion stops both ambient diagrams |
| Landing example | Entry, leverage, short direction, outcome selection and reset update the displayed values correctly |
| Privy dialogs | Dark desktop and light mobile login modals open without errors or overflow; no authentication or signature was submitted |
| Deliberately blocked RPC and history requests | Explicit errors appear; retry restores market data/discovery; configured oracle records remain visible |
| Invalid market URL | 404 retained for invalid addresses |

The preview was stopped before replacing `.next`, then restarted successfully at
`http://localhost:3100`, avoiding the earlier stale CSS/chunk problem.

Raw local logs: `/tmp/eros-audit-final-{install,unit,integration,build,typecheck}.log`;
browser results: `/tmp/eros-audit-final-browser.json`, `/tmp/eros-audit-recovery.json`
and `/tmp/eros-audit-interactions.json`. The browser fault check waits for the
SDK's retry budget; an initial fixed 13-second wait was too short and was replaced
with a condition-based wait. No failed application assertion was discarded.

## Remaining work

1. Complete the inherited wallet dependency upgrade noted above.
2. Verify real Privy embedded and external login, account switching, rejected
   signatures and funded transactions with the user. Automated wallet guards and
   unauthenticated modal checks do not establish real signing.
3. Supply a trading-ready deployment: operator activation, funded wallets, fresh
   authenticated INDEX observations and counterpart orders. An actual oracle-backed
   book needs the authorized factory/governance work already documented.
4. For hosting, configure public HTTPS history and suitable RPC service. Local
   localhost history is valid only on this machine.
5. Optional features remain gated: calibrated leverage, delegated one-click
   trading and the protection worker require their documented configuration.
   The public Privy App ID and existing Envio token are already configured.


## CI simplification follow-up

The clean CI reproduction on Node 22 exposed an npm 10 lockfile incompatibility
with the original version-range override. The ws override now pins all 8.x
consumers to 8.21.3, while retaining ws 7.x for consumers that require that major.
The lockfile is regenerated with Node 22's npm and validated with a clean install.

The frontend push checks retain frozen installation, unit/integration tests and
the production build. Next.js checks application and generated-route TypeScript
during that build, so the separate typecheck is removed. Tests still execute in
CI; their separate static typecheck remains available locally. The blocking
dependency advisory check is removed at the user's request to simplify CI;
`npm audit --audit-level=high` remains available for dependency reviews. The
existing vulnerability patch stays in place. Each workflow cancels superseded
runs on the same ref.
