# Local journal recovery and crash drills

This procedure describes the implemented development path, with disabled configs
and chain 31337. It is a starting point for PF016/PF018/PF025 operator review,
not an approved Monad launch, key backend, fee-replacement or supervisor procedure.

Run the reproducible offline drill from this package:

```bash
npm run test:recovery
```

The runner builds the package, executes the crash and relay suites and writes
`artifacts/verification/recovery.json` and `recovery.tap`. Every kill case uses a
fresh temporary directory. The child sends itself OS SIGKILL immediately after
the selected boundary, without running closes, release or finally handlers.
The parent starts another process, verifies archive contents and checks ordered
continuation. Temporary fixtures are removed after assertions.

| Crash boundary | Durable state that recovery must honor |
|---|---|
| COLLECTED | Raw source capture; no allocated packet yet |
| ALLOCATED | Sequence and immutable unsigned packet |
| SIGNING | Frozen packet entered signing; no signer reservation yet |
| SIGNER_RESERVED | Independent observation signer reserved identity/digest; signature still null |
| SIGNER_SIGNED | Signer has signature, packet journal has not stored it yet |
| SIGNED | Exact observation signature stored in packet journal |
| PREPARING | Relay nonce reserved, no raw transaction stored |
| TX_SIGNED | Scripted transaction signer retained raw bytes; relay not yet READY |
| READY | Exact transaction/hash archived before send intent |
| UNKNOWN | Send intent persisted before network call; outcome uncertain |
| BROADCAST | Scripted chain accepted, process died before recording returned hash |
| MINED | Validated receipt stored, fixture confirmations not complete |
| FINALIZED | Receipt meets the declared fixture confirmation count |

Real components are Worker, Journal, PacketStore, LocalTestSigner, LocalRelay,
SQLite WAL/FULL persistence, raw signing and OS process termination. The source,
transaction-signer ledger, chain acceptance, blocks and receipts are scripted.
Tests compare packet/digest/signature bytes across restart, inspect the null and
stored signer reservation separately, preserve transaction identity, resume
sequences 1/2 and nonces 0/1 and avoid a second broadcast after already accepted
delivery. This evidence complements the separate genuine-source/local-Anvil
graceful restart campaign; it does not extend that campaign into a live crash test.

## Restart procedure

1. Pause output and preserve source, packet, observation-signer, relay and
   lifecycle archives plus independent transaction-signer history. Keep the
   original failed files for review. SQLite WAL files can contain committed data;
   copying only the main file from a running or killed writer is not a backup.
2. Check the process actually stopped. Respect stored writer leases and fences;
   an immediate replacement can correctly return WRITER_BUSY. The fixture waits
   by advancing its declared clock eleven seconds, beyond its short leases. This
   is not an approved production lease duration or permission to alter host time.
3. Reopen and verify archives. Check configured chain/engine/code/ABI/listing/
   rules/signer pins with the actual approved reader. Check current canonical
   sourceState and independent signer reservations before allowing allocation.
   A higher unknown chain sequence, incompatible time, signer reservation ahead
   of the packet archive, or unknown pending nonce requires recovery review.
4. Reconcile receipts at named canonical blocks before retrying. A returned hash
   is not acceptance. Missing receipt is uncertainty, not proof of non-delivery.
   A valid existing receipt can be recovered after source headroom expires;
   this read does not refresh or send the old packet.
5. Retry only an identical archived observation and transaction while headroom,
   ownership, identity, lifecycle and spend limits permit it. Do not replace
   timestamps, prices, signature bytes, sequences or reserved nonces to make
   an old packet pass. Signer reservation retries must preserve identity/digest.
6. Resume new samples only after stream and shared relay-account recovery allows
   it. The continuous service follows its internal scheduler; its supervisor
   restarts the process. Repeated cron launches can contend for the same leases.

The standalone drill manually composes these existing journal operations. It
does not install a supervisor or certify full LocalPipeline/engine startup after
every kill. The joined pipeline has separate graceful restart tests; an owned
Anvil OS-crash campaign remains additional work.

## Expiry, restore and quarantine

An unreserved expired observation burns its sequence and requires genuinely new
evidence. An expired reserved transaction in PREPARING, READY, UNKNOWN or ORPHANED
persists `QUARANTINED / RESERVED_NONCE_HEADROOM_EXPIRED`, including on restart or
after a slow resimulation. Exact packet and raw bytes remain retained. This
blocks new nonce allocation on the shared relay account, including other markets;
an empty raw field does not mean the reserved nonce is free.

Read-only receipt reconciliation remains possible for a transaction hash even
when its delivery is quarantined. A matching canonical accepted receipt can
resolve an already delivered transaction. Otherwise, the current bot has no
approved replacement/cancellation mechanism. Preserve the reservation and involve
the owner to define an authorized recovery action; do not delete the delivery or
edit next_nonce. Operator clearance is not implemented by a magic reset flag.

Restore drills prove that an older empty packet snapshot is rejected when the
surviving observation signer reserved an identity, and that an older relay snapshot
is rejected when the scripted chain has consumed its nonce. Backups in these
fixtures are made from closed databases before allocation, not by copying a
running WAL database. They do not certify a production backup system, a restored
transaction signer, coordinated rollback of every archive, or loss of all history.

Lifecycle/source quarantine stays independent of relay recovery. Changed rules,
wrong identities, stale/future time, source closure or unavailable engine reads
cannot be repaired by refreshing publication time or manufacturing a final price.
Lifecycle checkpoint reorg/contradiction, recording STOPPED or a reserved nonce
blocked by lifecycle needs its existing policy and owner review. See
[lifecycle.md](lifecycle.md) and [decisions.md](decisions.md).

Still required: approved production signer/transaction-signer backup controls,
block-labeled canonical startup reads, finality and RPC disagreement policy,
fee replacement/cancellation, disk-full/permissions/IO and interrupted-transaction
drills, actual supervisor startup, load budgets and owner-reviewed runbooks.
