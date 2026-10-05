import { encodeFunctionData, erc20Abi, getAddress, type Abi, type Address, type ContractFunctionArgs, type ContractFunctionReturnType } from 'viem'
import { RegistryBookRiskEngineAbi } from './abi/RegistryBookRiskEngine'
import { CollateralVaultAbi } from './abi/CollateralVault'
import { publicManifestSchema, type PublicManifest } from './trading-manifest'

export type PlaceOrder = ContractFunctionArgs<typeof RegistryBookRiskEngineAbi, 'nonpayable', 'placeOrder'>[0]
export const OrderKind = { LIMIT: 0, IOC: 1, POST_ONLY: 2 } as const
export type SettlementStatus = ContractFunctionReturnType<typeof RegistryBookRiskEngineAbi, 'view', 'getSettlementStatus'>

/** UI readiness from the actual contract gate and the owner's escrow, never from oracle finality alone. */
export function claimAvailability(settlement: Pick<SettlementStatus, 'claimsEnabled'>, claimAtoms: bigint) {
  if (typeof claimAtoms !== 'bigint' || claimAtoms < 0n) throw new Error('INVALID_CLAIM_ATOMS')
  if (settlement.claimsEnabled !== true) return { available: false, reason: 'CLAIMS_DISABLED' as const }
  return claimAtoms === 0n ? { available: false, reason: 'NO_CLAIM' as const } : { available: true, reason: 'CLAIMABLE' as const }
}
const UINT256_MAX = (1n << 256n) - 1n

function amount(atoms: bigint) {
  if (typeof atoms !== 'bigint' || atoms <= 0n || atoms > UINT256_MAX) throw new Error('POSITIVE_INTEGER_ATOMS_REQUIRED')
  return atoms
}
function boundedInteger(value: number, maximum: number, label: string, minimum = 0) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new Error(`INVALID_${label}`)
  return value
}
function order(value: PlaceOrder) {
  boundedInteger(value.kind, 2, 'ORDER_KIND')
  boundedInteger(value.tick, 999, 'TICK', 1)
  boundedInteger(value.maxFills, 8, 'MAX_FILLS', 1)
  boundedInteger(value.expiryBlock, 0xffffffff, 'EXPIRY_BLOCK')
  if (typeof value.size !== 'bigint' || value.size <= 0n || value.size >= 1n << 64n) throw new Error('INVALID_LOTS')
  if (typeof value.isBuy !== 'boolean' || typeof value.reduceOnly !== 'boolean') throw new Error('INVALID_ORDER_FLAGS')
  return value
}

/** Builds owner-bound requests. The caller must simulate, verify wallet identity, sign and reconcile receipts. */
export function createTraderClient(input: PublicManifest, marketName: string, ownerInput: Address) {
  const manifest = publicManifestSchema.parse(input)
  const market = manifest.markets.find(value => value.name === marketName)
  if (!market) throw new Error('UNKNOWN_MARKET')
  const owner = getAddress(ownerInput)
  if (owner === '0x0000000000000000000000000000000000000000') throw new Error('ZERO_OWNER')
  const vault = manifest.contracts.CollateralVault.address
  const token = manifest.contracts.CollateralToken.address
  const context = { account: owner, chainId: manifest.chainId } as const
  const engineRead = { ...context, address: market.engine, abi: RegistryBookRiskEngineAbi } as const
  const vaultRead = { ...context, address: vault, abi: CollateralVaultAbi } as const
  const tokenRead = { ...context, address: token, abi: erc20Abi } as const
  return {
    owner, market, chainId: manifest.chainId, vault, token,
    assertWallet(chainId: number, selectedOwner: Address) {
      if (chainId !== manifest.chainId) throw new Error('WRONG_WALLET_CHAIN')
      if (getAddress(selectedOwner) !== owner) throw new Error('WRONG_WALLET_OWNER')
    },
    approve: (atoms: bigint) => ({ ...tokenRead, functionName: 'approve' as const, args: [vault, amount(atoms)] as const }),
    deposit: (atoms: bigint) => ({ ...vaultRead, functionName: 'deposit' as const, args: [amount(atoms)] as const }),
    allocate: (atoms: bigint) => ({ ...vaultRead, functionName: 'allocate' as const, args: [market.engine, amount(atoms), false] as const }),
    placeOrder: (value: PlaceOrder) => ({ ...engineRead, functionName: 'placeOrder' as const, args: [order(value)] as const }),
    cancel: (orderId: number) => ({ ...engineRead, functionName: 'cancel' as const, args: [boundedInteger(orderId, 0xffffffff, 'ORDER_ID', 1)] as const }),
    cancelAll: () => ({ ...engineRead, functionName: 'cancelAll' as const }),
    release: (atoms: bigint) => ({ ...engineRead, functionName: 'release' as const, args: [amount(atoms)] as const }),
    withdraw: (atoms: bigint) => ({ ...vaultRead, functionName: 'withdraw' as const, args: [amount(atoms)] as const }),
    // The claimant and beneficiary remain the selected owner; a backend router must not replace account.
    claim: () => ({ ...vaultRead, functionName: 'claim' as const, args: [market.engine, owner] as const }),
    participantId: () => ({ ...engineRead, functionName: 'participantId' as const, args: [owner] as const }),
    accountRisk: (traderId: number) => ({ ...engineRead, functionName: 'accountRiskView' as const, args: [boundedInteger(traderId, 0xffffffff, 'TRADER_ID', 1)] as const }),
    previewOrder: (traderId: number, value: PlaceOrder) => {
      order(value)
      return { ...engineRead, functionName: 'previewOrder' as const,
        args: [boundedInteger(traderId, 0xffffffff, 'TRADER_ID', 1), value.isBuy ? 0 : 1, value.tick, value.size, value.reduceOnly] as const }
    },
    marketRisk: () => ({ ...engineRead, functionName: 'marketRiskView' as const }),
    freeBalance: () => ({ ...vaultRead, functionName: 'freeAtoms' as const, args: [owner] as const }),
    walletBalance: () => ({ ...tokenRead, functionName: 'balanceOf' as const, args: [owner] as const }),
    claimable: () => ({ ...vaultRead, functionName: 'claimAtoms' as const, args: [market.engine, owner] as const }),
    settlement: () => ({ ...engineRead, functionName: 'getSettlementStatus' as const }),
    claimsStatus: () => ({ ...engineRead, functionName: 'claimsStatus' as const }),
  }
}

export type TraderClient = ReturnType<typeof createTraderClient>
export type TraderTransaction = ReturnType<TraderClient['approve' | 'deposit' | 'allocate' | 'placeOrder' | 'cancel' | 'cancelAll' | 'release' | 'withdraw' | 'claim']>

/** Wallet-neutral transaction fields, preserving the sender and exact integer calldata. */
export function transactionData(request: TraderTransaction) {
  return { account: request.account, chainId: request.chainId, to: request.address,
    data: encodeFunctionData({ abi: request.abi as Abi, functionName: request.functionName, args: 'args' in request ? request.args : [] }), value: 0n }
}
