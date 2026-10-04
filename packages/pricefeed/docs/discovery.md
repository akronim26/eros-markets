# Read-only market discovery and metadata validation

Original milestone 3 / PF009 now supplies bounded Gamma discovery and source
metadata monitoring. Candidates never enable workers, choose the Eros YES token,
assign scheduledT, approve a mapping or access a signer/relay.

## Run

From `packages/pricefeed`, build with the pinned toolchain, then:

```bash
./node_modules/.bin/node dist/src/cli.js discover-markets \
  --category sports --tag-slug sports --page-size 20 --max-pages 3
```

Use politics/politics or crypto/crypto for the other categories. A subcategory
tag such as nba can be requested with category sports. The category is the
operator's discovery label; tag membership and an approved event mapping still
require evidence. No source substitution or category-specific price model is used.

The command prints JSON containing original response bodies, headers, arrival
times, SHA-256 evidence and candidates. Save that output for the mapping reviewer.
It has no RPC, key, journal or activation option. Source values remain strings;
source endDate is retained as evidence and never replaces the Eros deadline.

## Pinned read contract

- Resolve a tag with `GET /tags/slug/{slug}` and check its returned slug/string ID.
- Read `GET /events/keyset?closed=false&limit=...&tag_id=...`.
- Send the returned `next_cursor` as URL-encoded `after_cursor`, retaining the
  same tag/filter/page size. A cursor cannot alter the hostname or query filters.
- Interpret null, omitted or empty next_cursor as terminal under this diagnostic
  policy; those terminal representations are fixture-tested. Actual sampled
  pages had nonempty continuation cursors. A bounded scan reports MAX_PAGES and
  `scanComplete: false` when a cursor remains.
- Limits: page size 1–100, pages 1–20, at most 1,000 markets per event and 5,000
  candidates per scan. The CLI transport bounds each body to 1 MB, each request
  to four seconds and one retry with shared 100 ms request spacing. Body/timeout,
  HTTP, duplicate IDs/conditions/tokens, cursor loops and schema errors fail visibly.

Provider references checked on 05 October 2026:
[Discover Markets](https://docs.polymarket.com/market-data/discover-markets) and
[Market Details](https://docs.polymarket.com/market-data/market-details).
The tested wire profile is `GAMMA_EVENTS_KEYSET_V1`; it uses direct public HTTP,
without adding an SDK or accepting an alternate pagination shape silently.
Actual responses advertise Tag.json and EventsKeysetListResponse.json schema URLs;
the advertised schema documents could not be retrieved with the web reader, so
no claim of validating against their complete JSON Schema is made. The selected
response contract is validated by retained real responses and adversarial fixtures.

## Candidate and cache policy

Binary labels and token IDs must have matching lengths, unique nonempty labels,
unique validated decimal-string token IDs and an exact condition identity. Team
names are preserved; no first-element YES assumption or NO-book inversion occurs.
Missing rules/resolution source, invalid UTC/calendar dates, inactive/closed books,
unknown trading flags and unverified tag membership remain BLOCKED with reason
codes. Negative-risk, augmented-negative-risk and Other outcomes are blocked for
explicit semantic review; unknown flags are never assumed false. A valid candidate
is only REVIEW_REQUIRED, still disabled and unapproved. Liquidity, terms, clocks,
exception equivalence, horizon, calibration and Eros listing review remain necessary.

The existing worker's bounded metadata cache retains its original rules-digest
encoding. It now validates known-field types and duplicate/conflicting event
membership. A failed refresh clears the old healthy interpretation and must
refresh again; it cannot produce a healthy book with invalid metadata attached.
Rules changes quarantine before another book read. A separate status digest
monitors event/market trading and negative-risk flags. Status changes are archived
and quarantined across restart, including attempted reopening. Initial unknown or
closed status remains unavailable. These are diagnostic fail-closed rules, not
approval of negative-risk mappings or a production closure policy.

Older archives gain status monitoring by deriving the baseline from their retained
raw event/market bytes. Old captures, rules digests, sequences, packets/signatures
and transaction history are preserved. Corrupt restored status evidence blocks
the worker. Never erase a journal or reset a nonce to clear review requirements.
Engine lifecycle remains separate: source quarantine does not halt or settle the
engine, fabricate an INVALID price or change its recording deadline.

## Evidence

Actual read-only runs used two pages of two events for each category. They yielded
123 sports, 14 politics and 23 crypto candidates; all remained BLOCKED, with
incomplete structured source rules, closed markets and negative-risk cases among
the reasons. All scans stopped at the explicit page bound and remain incomplete.
These partial batches establish transport/schema/identity handling, not category
suitability or approval of a particular listing. No configuration was activated,
signature produced or transaction sent.

`artifacts/discovery/{sports,politics,crypto}-live.json` retain exact source bodies.
`scripts/review-discovery.py` independently checks raw hashes, pagination, token
mapping, disabled state and conservative rejection reasons; its result is
`artifacts/discovery/live-review.json`. Tests include scripted valid candidates,
null/type/negative-risk cases, pagination loops, duplicate identities, hostile
cursors, metadata refresh failures and persistent rule/status quarantine.
Use `npm run test:discovery` for focused checks. Human PF gates remain unaccepted.

The Monad full-window/gap proof is deferred by the user after the authentic
268/300 failure. Its retry policy is inactive and no additional spend is approved.
Next original milestone: stream hints, heartbeat and reconnect/resync recovery.
