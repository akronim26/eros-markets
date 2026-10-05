# Oracle SDK validation

Run `bun test` from this package with the project's pinned Forge on `PATH`.
The ABI checks compare compiler output, checked-in JSON snapshots, generated
TypeScript modules and `oracle/abi/SHA256SUMS`. Run `bun run sync-abis` only when
intentionally refreshing snapshots after reviewing a source/ABI change.

ABI fingerprints use UTF-8 text with CRLF line endings converted to LF, matching
the generated and Git-stored files. This permits Windows checkouts without
rewriting snapshots. No other whitespace, property ordering or ABI fields are
normalized; substantive changes and extra/missing newlines still change the
fingerprint. `test/abiText.test.ts` verifies both portability and drift rejection.
Filesystem fixtures use file-URL conversion rather than URL pathnames, which
preserves Windows drive letters and paths containing spaces.

The ordinary deployment loader still requires the full oracle deployment
schema, including UMA metadata. The keeper's explicitly selected chain-31337
local integration mode has a separate mock-venue manifest schema; it does not
relax this SDK loader or pretend a mock is a deployed UMA adapter.
