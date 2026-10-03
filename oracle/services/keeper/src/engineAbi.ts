// Task O31.3: the engine calls the keeper makes after Final (plan §9.1 "engine follow-up", owned by Risk), from
// Risk's SettlementController / InvalidPrice (contracts/src/settlement, the names checked on main and
// integration/risk). The oracle SDK does not carry Risk's ABIs, so this copy is pinned by test/engineAbi.test.ts
// against `forge inspect EngineHarness abi` (the seam harness inherits Risk's SettlementController).
export const engineFollowUpAbi = [
  {
    type: 'function',
    name: 'captureInvalidPrice',
    inputs: [],
    outputs: [
      { name: 'status', type: 'uint8', internalType: 'enum LifecycleMath.InvalidReadiness' },
      { name: 'captured', type: 'bool', internalType: 'bool' },
    ],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'finishPreparation',
    inputs: [],
    outputs: [{ name: 'claimsEnabled', type: 'bool', internalType: 'bool' }],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'preparePayoutChunk',
    inputs: [{ name: 'maxAccounts', type: 'uint256', internalType: 'uint256' }],
    outputs: [
      {
        name: 'p',
        type: 'tuple',
        internalType: 'struct IAccountingPort.JobProgress',
        components: [
          { name: 'cursor', type: 'uint64', internalType: 'uint64' },
          { name: 'count', type: 'uint64', internalType: 'uint64' },
          { name: 'done', type: 'bool', internalType: 'bool' },
        ],
      },
    ],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'prepareSnapshotChunk',
    inputs: [{ name: 'maxAccounts', type: 'uint256', internalType: 'uint256' }],
    outputs: [
      {
        name: 'p',
        type: 'tuple',
        internalType: 'struct IAccountingPort.JobProgress',
        components: [
          { name: 'cursor', type: 'uint64', internalType: 'uint64' },
          { name: 'count', type: 'uint64', internalType: 'uint64' },
          { name: 'done', type: 'bool', internalType: 'bool' },
        ],
      },
    ],
    stateMutability: 'nonpayable',
  },
] as const

/** LifecycleMath.InvalidReadiness. */
export const InvalidReadiness = { NOT_YET: 0, CAPTURE_TWAP: 1, WAIT_GRACE: 2, CAPTURE_FALLBACK: 3, BLOCKED: 4 } as const
/** MathTypes.FinalOutcome (the engine's own numbering: NO = 1, YES = 2). */
export const EngineOutcome = { UNSET: 0, NO: 1, YES: 2, INVALID: 3 } as const
