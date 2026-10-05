# Evidence kept in Git and locally

The repository keeps source code, tests, lockfiles, deployment configuration,
public receiver pins/ABI/source snapshot, required runtime inputs and compact
review reports. Generated TAP/log/stderr/exit files, duplicate timestamped
pipeline reports, raw discovery responses and bulky Monad run reports are ignored.
The historical root pricefeed smoke/reverification raw responses are ignored too;
their scripts, summaries, manifests and protected-file baseline remain tracked.

Cleanup removes these outputs from the Git index only. Existing local files stay
at their original paths so historical review scripts still work on this machine.
Ignored files are absent from a fresh clone and from Render's source checkout.
Render's read-only profile uses the tracked calibration inputs and does not need
historical provider responses or Monad campaign output. Keys and runtime journals
remain in the ignored `var/` directory; they were not moved or deleted.

`fixtures/monad-coverage-history.json` contains exact observation and accepted-log
inputs extracted from the retained nine-price and 29-price run reports. It pins
each full report's SHA-256 and original commit. The independent historical replay
tests still check the actual **134/300** and **268/300** unavailable windows. This
fixture does not establish raw-source authenticity, signatures, journal integrity,
current canonicality or campaign acceptance; those require full evidence.

Full historical reviews and `report:monad-cost` require the ignored public reports
and, where checked, the associated local SQLite evidence. Their absence is an
unavailable review, not a pass. Compact review JSON documents historical results
and cannot replace a new verification of the original inputs.

For an existing historical public report, restore its committed bytes locally:

```bash
git show a3c17b3:packages/pricefeed/artifacts/monad-testnet/optimized-small-run.json > packages/pricefeed/artifacts/monad-testnet/optimized-small-run.json
```

Run this from the repository root and check the report's pinned hash before using
it. Runtime journals and keys are not in Git and require their separate recovery
procedure. Restoring a public report does not restore an operational bot.

The cleanup summary in `artifacts/verification/repository-cleanup.json` records
counts, byte totals and a digest of the excluded file inventory. The full inventory
stays locally in `var/repository-cleanup/`.

Already committed outputs remain in Git history. A cleanup commit reduces the
current checkout and future generated diffs; an initial push still includes the
older objects. No history rewrite or force push is part of this cleanup.
