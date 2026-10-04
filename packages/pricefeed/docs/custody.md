# Transaction recovery and diagnostic signer custody

Original milestone 5 hardens the existing testnet signer and recovery path. It
does not introduce a new signer, replace the deployed receiver's pinned signer,
raise a spending limit or authorize an external transaction.

## Key and journal files

Testnet observation and transaction wallets remain separate encrypted files in
the ignored `var/monad-testnet/keys/` directory. Existing key encoding is unchanged.
Loading a key checks its public address against the selected role's configured
identity. Known public fixture keys are rejected.

Both key and unlock files require a real owner-only immediate parent, owner-only
regular-file permissions, current-user ownership and one hard link. Every parent
component is checked for symlinks, and the final file is opened with no-follow.
Paths are normalized once and errors contain fixed codes, not key/password data.
An alias to a private directory is rejected even if its target has safe permissions.

Creation uses exclusive no-follow opens, mode 0600, file fsync and parent-directory
fsync. It never overwrites existing custody files. A failed two-file creation cleans
only the inode(s) created by that attempt; an existing/replaced file is preserved.
A process killed between writes can still leave a partial setup requiring review.
There is no automatic regeneration of a missing wallet or password.

Derived-key, password and temporary plaintext buffers are cleared on both success
and failure. JavaScript strings and the unlocked account closure cannot provide
guaranteed memory erasure. This remains local diagnostic custody; storing unlock
material beside the encrypted wallet is not approved production secret isolation.

Before opening testnet signer/service/budget/recovery journals, their main files
and any WAL/SHM files must be real, current-user-owned, single-link files under an
owner-only immediate parent. Missing restore journals fail closed. Initializing
a missing main DB with an orphaned WAL/SHM file also fails closed. Legacy main-file
modes are protected by the owner-only parent; existing files are not chmodded.
The checks assume the owning OS user is trusted and do not prevent a malicious
same-user process changing a path between checks and SQLite opening it.

## Signing history and restart

Observation reservations now validate identity/namespace/sequence, uint64 bounds,
digest format, checksum and canonical low-s/27-or-28 recovery-byte encoding.
`verifyJournal()` recovers retained signatures against the pinned observation
address. Cryptographic cache entries bind exact identity/digest/signature bytes
and are bounded to 1,024 entries; checksums and identity fields are reread each time.
Cached signing retries receive the same signature check and writer-fence recheck.

The joined Monad pipeline requires journal verification before reconciling signed
history at startup and at subsequent chain/lifecycle checkpoints. Even rewriting
both packet and signer signature fields with fresh checksums cannot substitute
a signature from a different wallet. A mismatch persistently quarantines the
relay; restarting does not approve it. Constructor failures close their DB handles.

The existing independent transaction-signer journal still pins sender, chain and
journal ID, reserves exact nonce/request identity before signing, and retains
raw transaction/hash before returning them. Backends ahead/behind the relay,
unknown chain history and divergent nonce/request terms remain rejected.

## Bounded recovery

The implemented cancellation remains narrowly scoped: a known expired final
reservation whose original price transaction has never been broadcast. It signs
an empty-data, zero-value, 21,000-gas transaction to the sender at the same nonce,
under the existing finite budget. It preserves the original packet, observation
signature, transaction request and raw price transaction.

Every recovery RPC method is now bounded by the existing relay policy's
`timeoutMs`, even if a custom transport ignores its own timeout. Provider errors
are reduced to fixed codes. A failure before preparation rolls back/releases
all five journal locks. The receipt polling `waitMs` remains separate from each
RPC deadline; it is not a whole-command wall-clock guarantee.

Send intent and UNKNOWN state are committed before broadcasting. A send timeout
cannot prove non-delivery. A subsequent recovery checks receipts/canonical state
and uses only the retained bytes; it does not change fees, timestamps or nonce.
A matching finalized cancellation receipt is required before the delivery becomes
CANCELLED and the publisher may continue. Receipt/RPC failures preserve uncertainty.

This is not general replacement of an already-broadcast price transaction.
Unknown broadcast history, reorgs, key loss/compromise, or a reserved nonce blocked
by lifecycle/source changes retain their existing stop/review requirement. There
is no reset-journal or clear-quarantine switch. The engine exposes no hot
observation-signer rotation path; losing that key cannot be repaired by generating
a different one and continuing the same listing.

## Checks and remaining operating work

Run `npm run test:custody` for the focused fixture suite. It covers corrupt signer
history, unsafe parents/links, creation failure, nonce contention/restore, stalled
RPC reads, timed-out sends, immutable retry and persistent startup quarantine.
The source/chain are scripted; local SQLite and encrypted signing are real.
No MON is spent by these tests.

Verification on 05 October 2026: build exit 0, final full Node suite **388/388**,
focused suite **55/55**, wire compatibility exit 0, **144** independent impact
vectors and **5** independent coverage cases. A read-only audit of the existing
testnet journals verified **36 retained observation signatures / 30 transaction
signatures** and all existing journal paths. It unlocked no keys, produced no
signatures and sent no transactions. All five active journals remained byte-identical.

Raw logs stay ignored in `var/verification/custody/`; compact verification is in
`artifacts/verification/custody-unit.json`. Production secret backend/custodian
approval, actual hosted restore/continuation and general fee-replacement policy
remain open. Original milestone 8 now supplies [private diagnostic backup/restore
drills and local/Render log monitoring](operations.md); offsite scheduling and
named operator acceptance remain pending. The deferred 268/300 Monad coverage
proof remains unpassed.
