# Shared sports resolution rules

`oracle/packages/feedspec/src/sports.ts` implements `sports-v1`. CRE, listing
simulations and the independent watchdog use this same evaluator.

Every immutable binding fixes the provider, event ID, competition, season,
participants, scheduled start, scoring scope and predicate. Participants use
provider IDs; MMA additionally pins the provider's weight-class label. A changed
schedule or identity cannot silently resolve another event.

Supported predicates:

| Predicate | Meaning |
| --- | --- |
| Winner | Selected participant wins the bound event. |
| Draw | The final score is tied; available only for sports that allow it. |
| Total over | Combined score strictly exceeds `halfPoints / 2`; no floating point rounding. Volleyball uses sets. |
| Top N | Selected F1 driver has an official classification position at most N. |

Football uses 90 minutes plus stoppage time. Its initial adapter sends extra-time
and shootout cases to review. Other team sports use official full-game totals;
period totals are checked where the provider supplies them. Incomplete, cancelled,
postponed, awarded or contradictory results produce no binary oracle report. MMA
requires an unambiguous winner; no-contest/draw/overturned results need review.
F1 requires a completed race **and** a complete, unique classification from the
same race. CRE and watchdog fetch that second endpoint independently with the
same server-side secret. The binding pins the complete expected driver roster.

These are Eros rules. A Polymarket-linked market must separately be checked for
equivalent overtime, postponement, cancellation and split-payout treatment. A
matching team name is insufficient. Index pricing and settlement sources remain
independent; a market may instead explicitly follow Polymarket's finalized binary
payout. Splits/unavailable payouts must enter oracle review rather than become NO.

## Use

Create a reviewed `SportsBinding` JSON, then run:

```sh
bun oracle/e2e/src/verify-sports-cre.ts tmp/binding.json tmp/new-sports-check
```

The tool fetches the exact source, generates the immutable FeedSpec and runs the
real CRE CLI dry-run. Its report records the expected outcome and value hash.
The secret is read from `oracle/workflows/.env` and is never exported. This command
does not broadcast. `sportsFeed(binding, authRef)` supplies the FeedSpec for a
listing pack; authorize its provider/authRef and 7,200/21,600-second feed timing
bounds through registry governance before listing. Existing short feed bounds do
not permit these sports feeds automatically.

## Validation on 6 October 2026

Authenticated result captures validated baseball, football, handball, hockey,
volleyball, NBA, American football, MMA and F1. NBA and F1 also passed real CRE CLI
simulations using the new shared rules. MMA/F1 captures use 2024 data because the
Free plan refused current-season queries. Rugby's accessible dates returned no
fixtures; its adapter has no live-result validation yet. `/status` access alone
does not prove future-event coverage. The Free plan reports 100 requests/day per
sport; F1 needs two requests for a complete final evaluation.

Reports are retained in `tmp/sports-unified-20261006/`. Captured result fixtures
under the FeedSpec tests are historical evidence, not live-market settlement.
The legacy `football-regulation-v1` format remains supported so existing evidence
and immutable specifications keep their meaning.
