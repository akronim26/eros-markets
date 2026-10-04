# Keeper engine enrollment

The keeper requires `ENGINE_IDENTITIES_FILE`, a JSON file bound to the deployment's
`chainId` and `MarketRegistry` address. Its fields are:

| Field | Value |
| --- | --- |
| `version` | `1` |
| `chainId` | The deployment's numeric chain ID |
| `registry` | The deployment's `MarketRegistry` address |
| `profiles` | A nonempty array of approved runtime profiles |
| `profiles[].kind` | `stub` for `ResolutionEngineStub`, or `book-risk` for `BookRiskEngine` / `RegistryBookRiskEngine` |
| `profiles[].runtimeCodehash` | The full 32-byte keccak256 hash of verified deployed runtime bytecode |

One file can include both kinds. Every runtime hash must occur once. This change
does not enroll existing deployments or supply a live identity file.

Before enrolling a new direct engine:

1. Verify the RPC chain ID and read the market's engine from the configured registry.
2. Verify the deployment provenance and runtime against the reviewed engine build
   and constructor arguments, then calculate `keccak256(eth_getCode(engine))`.
   A runtime hash supplied by an untrusted market is not sufficient verification.
3. Add the verified hash with its engine kind to the identity file. Constructor
   immutables affect runtime hashes, so a new market may need its own profile.
4. Verify that each required keeper action has a measured gas limit for that
   engine. Existing `RealEngine` gas entries must be checked for actual
   evidence for the exact engine variant and runtime; a seam-harness measurement
   is not that evidence. The integration factory deploys `RegistryBookRiskEngine`.
5. Start or restart the keeper with `ENGINE_IDENTITIES_FILE` set to that file.

Only direct, immutable deployments are supported by this enrollment procedure.
Proxy and clone approval requires implementation validation that is not provided
here; do not enroll their forwarding runtime as a direct engine profile.

The keeper checks the RPC chain and each market's runtime every tick, during job
checks, and immediately before sending. Unknown engines, empty code, read failures
and changed identities stop that market's jobs while other verified markets
continue. A changed member is removed from a pending batch and its gas limit is
recomputed for the remaining members. Only verified stubs use `finalizeMany`;
verified real engines finalize individually and may need settlement preparation.
Missing gas entries still refuse sends. The identity file is loaded at startup;
approval changes require a restart.

## Real-engine gas provenance

Engine-touching jobs on `book-risk` markets additionally require the gas entry to
name `BookRiskEngine` or `RegistryBookRiskEngine`, include the validated runtime hash, identify its measurement
chain and source, and record positive, integer transaction gas no larger than the
limit. This applies to halt, finalize, void, and every settlement preparation call.
Missing or incompatible provenance produces `no-gas-limit`; the earlier
`SettlementController` seam measurements do not authorize these jobs.

The following is a schema illustration, **not a usable or measured deployment
profile**. Replace every angle-bracket placeholder with reviewed measurement
evidence. The numeric placeholders are shown as strings solely to avoid supplying
invented gas values; the real file requires JSON numbers for them.

```json
{
  "limit": "<approved positive integer gas limit>",
  "engine": "RegistryBookRiskEngine",
  "engineRuntimeCodehashes": ["<verified 0x-prefixed 32-byte runtime hash>"],
  "measurement": {
    "chainId": "<numeric chain ID matching ENGINE_IDENTITIES_FILE>",
    "source": "<reviewed measurement artifact path or receipt reference>",
    "transactionGas": "<positive integer measured transaction gas>"
  }
}
```

These fields bind an operator-approved measurement to code and network. They do
not prove worst-case coverage. The measurement review must still cover the actual
engine, relevant states and account/chunk bounds, the chain's gas schedule, and
the margin applied to the measured transaction. No live gas entries are supplied
by this change.
