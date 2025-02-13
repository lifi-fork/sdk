import { hashTypedData } from 'viem'
import type { Address, TypedData, TypedDataDomain } from 'viem'
import { invariant } from '../../../utils/invariant.js'
import {
  MaxSigDeadline,
  MaxSignatureTransferAmount,
  MaxUnorderedNonce,
} from './constants.js'
import { permit2Domain } from './domain.js'

export interface Witness {
  witness: any
  witnessTypeName: string
  witnessType: Record<string, { name: string; type: string }[]>
}

export interface TokenPermissions {
  token: Address
  amount: bigint
}

export interface PermitTransferFrom {
  permitted: TokenPermissions
  spender: Address
  nonce: bigint
  deadline: bigint
}

export interface PermitBatchTransferFrom {
  permitted: TokenPermissions[]
  spender: Address
  nonce: bigint
  deadline: bigint
}

export type PermitTransferFromData = {
  domain: TypedDataDomain
  types: TypedData
  values: PermitTransferFrom
}

export type PermitBatchTransferFromData = {
  domain: TypedDataDomain
  types: TypedData
  values: PermitBatchTransferFrom
}

const TOKEN_PERMISSIONS = [
  { name: 'token', type: 'address' },
  { name: 'amount', type: 'uint256' },
] as const

const PERMIT_TRANSFER_FROM_TYPES = {
  TokenPermissions: TOKEN_PERMISSIONS,
  PermitTransferFrom: [
    { name: 'permitted', type: 'TokenPermissions' },
    { name: 'spender', type: 'address' },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint256' },
  ],
} as const

const PERMIT_BATCH_TRANSFER_FROM_TYPES = {
  TokenPermissions: TOKEN_PERMISSIONS,
  PermitBatchTransferFrom: [
    { name: 'permitted', type: 'TokenPermissions[]' },
    { name: 'spender', type: 'address' },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint256' },
  ],
} as const

function isPermitTransferFrom(
  permit: PermitTransferFrom | PermitBatchTransferFrom
): permit is PermitTransferFrom {
  return !Array.isArray(permit.permitted)
}

export function getPermitTransferData(
  permit: PermitTransferFrom,
  permit2Address: Address,
  chainId: number,
  witness?: Witness
): PermitTransferFromData {
  invariant(MaxSigDeadline >= permit.deadline, 'SIG_DEADLINE_OUT_OF_RANGE')
  invariant(MaxUnorderedNonce >= permit.nonce, 'NONCE_OUT_OF_RANGE')

  const domain = permit2Domain(permit2Address, chainId)

  validateTokenPermissions(permit.permitted)

  const types = witness
    ? ({
        TokenPermissions: TOKEN_PERMISSIONS,
        ...witness.witnessType,
        PermitWitnessTransferFrom: [
          { name: 'permitted', type: 'TokenPermissions' },
          { name: 'spender', type: 'address' },
          { name: 'nonce', type: 'uint256' },
          { name: 'deadline', type: 'uint256' },
          { name: 'witness', type: witness.witnessTypeName },
        ],
      } as const)
    : PERMIT_TRANSFER_FROM_TYPES

  const values = witness
    ? Object.assign(permit, { witness: witness.witness })
    : permit

  return {
    domain,
    types,
    values,
  }
}

export function getPermitBatchTransferData(
  permit: PermitBatchTransferFrom,
  permit2Address: Address,
  chainId: number,
  witness?: Witness
): PermitBatchTransferFromData {
  invariant(MaxSigDeadline >= permit.deadline, 'SIG_DEADLINE_OUT_OF_RANGE')
  invariant(MaxUnorderedNonce >= permit.nonce, 'NONCE_OUT_OF_RANGE')

  const domain = permit2Domain(permit2Address, chainId)

  permit.permitted.forEach(validateTokenPermissions)

  const types = witness
    ? {
        ...witness.witnessType,
        TokenPermissions: TOKEN_PERMISSIONS,
        PermitBatchWitnessTransferFrom: [
          { name: 'permitted', type: 'TokenPermissions[]' },
          { name: 'spender', type: 'address' },
          { name: 'nonce', type: 'uint256' },
          { name: 'deadline', type: 'uint256' },
          { name: 'witness', type: witness.witnessTypeName },
        ],
      }
    : PERMIT_BATCH_TRANSFER_FROM_TYPES

  const values = witness
    ? Object.assign(permit, { witness: witness.witness })
    : permit

  return {
    domain,
    types,
    values,
  }
}

// return the data to be sent in a eth_signTypedData RPC call
// for signing the given permit data
export function getPermitData(
  permit: PermitTransferFrom | PermitBatchTransferFrom,
  permit2Address: Address,
  chainId: number,
  witness?: Witness
): PermitTransferFromData | PermitBatchTransferFromData {
  if (isPermitTransferFrom(permit)) {
    return getPermitTransferData(permit, permit2Address, chainId, witness)
  }
  return getPermitBatchTransferData(permit, permit2Address, chainId, witness)
}

export function hash(
  permit: PermitTransferFrom | PermitBatchTransferFrom,
  permit2Address: Address,
  chainId: number,
  witness?: Witness
) {
  if (isPermitTransferFrom(permit)) {
    const { domain, types, values } = getPermitTransferData(
      permit,
      permit2Address,
      chainId,
      witness
    )

    return hashTypedData({
      domain,
      types,
      primaryType: witness ? 'PermitWitnessTransferFrom' : 'PermitTransferFrom',
      message: {
        ...values,
      },
    })
  }
  const { domain, types, values } = getPermitBatchTransferData(
    permit,
    permit2Address,
    chainId,
    witness
  )

  return hashTypedData({
    domain,
    types,
    primaryType: witness
      ? 'PermitBatchWitnessTransferFrom'
      : 'PermitBatchTransferFrom',
    message: { ...values },
  })
}

function validateTokenPermissions(permissions: TokenPermissions) {
  invariant(
    MaxSignatureTransferAmount >= permissions.amount,
    'AMOUNT_OUT_OF_RANGE'
  )
}
