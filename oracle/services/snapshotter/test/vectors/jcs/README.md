# RFC 8785 test vectors

Copied unchanged from the RFC 8785 author's reference implementation,
https://github.com/cyberphone/json-canonicalization (commit 19d51d7fe467d4706a3ff08adf8a748f29fc21e0),
Copyright 2018 Anders Rundgren, Apache License 2.0 (https://www.apache.org/licenses/LICENSE-2.0).

- `input/*.json`, `output/*.json`: `testdata/input` and `testdata/output`; each output is the canonical form of the
  input with the same name.
- `es6-numbers-10k.txt`: the first 10,000 lines of `es6testfile100m.txt.gz` (release `es6testfile`), lines
  `hex-ieee,expected`: an IEEE 754 double in hex and its JSON serialization. sha256
  b9f7a8e75ef22a835685a52ccba7f7d6bdc99e34b010992cbc5864cd12be6892.

From RFC 8785 itself (https://www.rfc-editor.org/rfc/rfc8785.txt), copied verbatim: `rfc8785-3.2.2-sample.json` (the
§3.2.2 sample), `rfc8785-3.2.3-canonical.json` (its canonical form, §3.2.3, without the display line wrap) and
`rfc8785-3.2.3-sorting.json` (the §3.2.3 sorting test data). The §3.2.4 bytes and the Appendix B table are written
out in `test/jcs.test.ts`.
