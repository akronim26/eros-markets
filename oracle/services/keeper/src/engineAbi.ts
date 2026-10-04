// The Risk engine calls the keeper makes after Final. The SDK does not carry Risk's ABIs, so this copy is pinned
// by test/engineAbi.test.ts against `forge inspect EngineHarness abi`.
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
/** MathTypes.FinalOutcome. The engine numbers NO = 1, YES = 2, unlike the oracle. */
export const EngineOutcome = { UNSET: 0, NO: 1, YES: 2, INVALID: 3 } as const
