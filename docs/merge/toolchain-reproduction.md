# Integration review toolchain

The reproducible integration target is **Foundry v1.8.3**, matching the existing
contracts CI pin. Solidity remains 0.8.30, Prague, optimizer 200; dependency
submodule pins are unchanged. Earlier 1.3.5 and 1.5.1 results remain historical.

The 2026-10-02 Windows review downloaded the official release archive from
https://github.com/foundry-rs/foundry/releases/tag/v1.8.3 and verified SHA-256
`e4d7302fa708423c8799f5a229dfecef311cfd68b046ce782788096318946304`
for `foundry_v1.8.3_win32_amd64.zip`. The executable is locally installed under
`tmp/foundry-v1.8.3`; it does not replace the user's global Foundry installation.
The Forge commit is `cae51ad458f6abb64852b7709eb784352429825d`.

`risk` and `ci` allow 1,000,000-byte test fixtures because CombinedBase embeds
three engine deployment variants, and v1.8.3 enforces their creation limits.
This does not assert that a production engine may exceed the target chain's
limit. Main's Monad 131,072-byte setting remains a separate production concern;
the test-only real-book composition is measured in `artifacts/risk/release-manifest.json`, but
production wiring, target-chain limits and gas remain unverified. B explicitly agreed to
forge 1.8.3 + solc 0.8.30 + Prague in the 2026-10-02 review; that agreement is no longer pending.

This review uses Python 3.12.10 and TypeScript 5.9.2. The historical specification
vector script additionally imports NumPy; this review uses NumPy 2.2.6 installed
only in `tmp/audit-python`. Economic reference implementations remain independent
Fraction/integer calculations; that script's sampled numerical check is not a proof.

PowerShell setup from the repository root:

```powershell
$env:PATH = (Resolve-Path tmp/foundry-v1.8.3).Path + ';' + $env:PATH
$env:PYTHONPATH = (Resolve-Path tmp/audit-python).Path
$env:FORGE_SNAPSHOT_EMIT = 'false'
& 'C:\Program Files\Git\bin\bash.exe' scripts/check-gate.sh G0
```

Run G0 through G7 in order. Task and gate runners retain actual versions, commands,
source commit, dirty state and hashes; technical success never invents an accepted
merge SHA or approval by another reviewer. Book gas snapshots are not rewritten.

The source-bound A review uses SHA-256 after normalizing CRLF to LF, so Git's
Windows checkout conversion does not invalidate an otherwise identical review.
Content changes, new source files and unrelated source ancestry still invalidate it.
