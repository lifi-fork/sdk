import type { LiFiStep, Process } from '@lifi/types'
import type {
  Address,
  Client,
  GetAddressesReturnType,
  Hash,
  Hex,
  SendTransactionParameters,
  TransactionReceipt,
} from 'viem'
import { estimateGas, getAddresses, sendTransaction } from 'viem/actions'
import type { GetCapabilitiesReturnType } from 'viem/experimental'
import { getCapabilities, sendCalls } from 'viem/experimental'
import { getAction } from 'viem/utils'
import { config } from '../../config.js'
import { LiFiErrorCode } from '../../errors/constants.js'
import { TransactionError } from '../../errors/errors.js'
import {
  getRelayerQuote,
  getStepTransaction,
  relayTransaction,
} from '../../services/api.js'
import { isZeroAddress } from '../../utils/isZeroAddress.js'
import { BaseStepExecutor } from '../BaseStepExecutor.js'
import { checkBalance } from '../checkBalance.js'
import { stepComparison } from '../stepComparison.js'
import type {
  LiFiStepExtended,
  StepExecutorOptions,
  TransactionParameters,
} from '../types.js'
import { waitForDestinationChainTransaction } from '../waitForDestinationChainTransaction.js'
import { checkAllowance } from './checkAllowance.js'
import { getNativePermit } from './getNativePermit.js'
import { parseEVMErrors } from './parseEVMErrors.js'
import { type PermitSignature, signPermitMessage } from './signPermitMessage.js'
import { switchChain } from './switchChain.js'
import { isEVMPermitStep } from './typeguards.js'
import { getMaxPriorityFeePerGas } from './utils.js'
import {
  type WalletCallReceipt,
  waitForBatchTransactionReceipt,
} from './waitForBatchTransactionReceipt.js'
import { waitForRelayedTransactionReceipt } from './waitForRelayedTransactionReceipt.js'
import { waitForTransactionReceipt } from './waitForTransactionReceipt.js'

export type Call = {
  data?: Hex
  to?: Address
  value?: bigint
  chainId?: number
}

export interface EVMStepExecutorOptions extends StepExecutorOptions {
  client: Client
}

export class EVMStepExecutor extends BaseStepExecutor {
  private client: Client

  constructor(options: EVMStepExecutorOptions) {
    super(options)
    this.client = options.client
  }

  // Ensure that we are using the right chain and wallet when executing transactions.
  checkClient = async (step: LiFiStepExtended, process?: Process) => {
    const updatedClient = await switchChain(
      this.client,
      this.statusManager,
      step,
      this.allowUserInteraction,
      this.executionOptions?.switchChainHook
    )
    if (updatedClient) {
      this.client = updatedClient
    }

    // Prevent execution of the quote by wallet different from the one which requested the quote
    let accountAddress = this.client.account?.address
    if (!accountAddress) {
      const accountAddresses = (await getAction(
        this.client,
        getAddresses,
        'getAddresses'
      )(undefined)) as GetAddressesReturnType
      accountAddress = accountAddresses?.[0]
    }
    if (accountAddress !== step.action.fromAddress) {
      let processToUpdate = process
      if (!processToUpdate) {
        // We need to create some process if we don't have one so we can show the error
        processToUpdate = this.statusManager.findOrCreateProcess({
          step,
          type: 'TRANSACTION',
        })
      }
      const errorMessage =
        'The wallet address that requested the quote does not match the wallet address attempting to sign the transaction.'
      this.statusManager.updateProcess(step, processToUpdate.type, 'FAILED', {
        error: {
          code: LiFiErrorCode.WalletChangedDuringExecution,
          message: errorMessage,
        },
      })
      this.statusManager.updateExecution(step, 'FAILED')
      throw await parseEVMErrors(
        new TransactionError(
          LiFiErrorCode.WalletChangedDuringExecution,
          errorMessage
        ),
        step,
        process
      )
    }
    return updatedClient
  }

  executeStep = async (step: LiFiStepExtended): Promise<LiFiStepExtended> => {
    step.execution = this.statusManager.initExecutionObject(step)

    // Find if it's bridging and the step is waiting for a transaction on the destination chain
    const destinationChainProcess = step.execution?.process.find(
      (process) => process.type === 'RECEIVING_CHAIN'
    )

    // Make sure that the chain is still correct
    // If the step is waiting for a transaction on the destination chain, we do not switch the chain
    // All changes are already done from the source chain
    // Return the step
    if (destinationChainProcess?.substatus !== 'WAIT_DESTINATION_TRANSACTION') {
      const updatedClient = await this.checkClient(step)
      if (!updatedClient) {
        return step
      }
    }

    const fromChain = await config.getChainById(step.action.fromChainId)
    const toChain = await config.getChainById(step.action.toChainId)

    let atomicBatchSupported = false
    try {
      const capabilities = (await getAction(
        this.client,
        getCapabilities,
        'getCapabilities'
      )(undefined)) as GetCapabilitiesReturnType
      atomicBatchSupported = capabilities[fromChain.id]?.atomicBatch?.supported
    } catch {
      // If the wallet does not support getCapabilities, we assume that atomic batch is not supported
    }

    const calls: Call[] = []

    const isBridgeExecution = fromChain.id !== toChain.id
    const currentProcessType = isBridgeExecution ? 'CROSS_CHAIN' : 'SWAP'

    // Find existing swap/bridge process
    const existingProcess = step.execution.process.find(
      (p) => p.type === currentProcessType
    )

    // Check if step requires permit signature and will be used with relayer service
    const isPermitStep = isEVMPermitStep(step)

    // Check if token requires approval
    // Native tokens (like ETH) don't need approval since they're not ERC20 tokens
    // We should support different permit types:
    // 1. Native permits (EIP-2612)
    // 2. Permit2 - Universal permit implementation by Uniswap (limited to certain chains)
    // 3. Standard ERC20 approval
    const nativePermit = await getNativePermit(
      this.client,
      fromChain,
      step.action.fromToken.address as Address
    )
    // Check if proxy contract is available and token supports native permits, not available for atomic batch
    const nativePermitSupported =
      !!fromChain.permit2Proxy &&
      nativePermit.supported &&
      !atomicBatchSupported &&
      !isPermitStep
    // Check if chain has Permit2 contract deployed. Permit2 should not be available for atomic batch.
    const permit2Supported =
      !!fromChain.permit2 && !!fromChain.permit2Proxy && !atomicBatchSupported
    // Token supports either native permits or Permit2
    const permitSupported = permit2Supported || nativePermitSupported

    const checkForAllowance =
      // No existing swap/bridgetransaction is pending
      !existingProcess?.txHash &&
      // Token is not native (address is not zero)
      !isZeroAddress(step.action.fromToken.address) &&
      // Token doesn't support native permits
      !nativePermitSupported

    if (checkForAllowance) {
      // Check if token needs approval and get approval transaction or message data when available
      const data = await checkAllowance({
        client: this.client,
        chain: fromChain,
        step,
        statusManager: this.statusManager,
        executionOptions: this.executionOptions,
        allowUserInteraction: this.allowUserInteraction,
        atomicBatchSupported,
        permit2Supported,
      })

      if (data) {
        // Create approval transaction call
        // No value needed since we're only approving ERC20 tokens
        if (atomicBatchSupported) {
          calls.push({
            chainId: step.action.fromToken.chainId,
            to: step.action.fromToken.address as Address,
            data,
          })
        }
      }
    }

    let process = this.statusManager.findOrCreateProcess({
      step,
      type: currentProcessType,
      chainId: fromChain.id,
    })

    if (process.status !== 'DONE') {
      try {
        let txHash: Hash
        if (process.txHash) {
          // Make sure that the chain is still correct
          const updatedClient = await this.checkClient(step, process)
          if (!updatedClient) {
            return step
          }

          // Wait for exiting transaction
          txHash = process.txHash as Hash
        } else {
          process = this.statusManager.updateProcess(
            step,
            process.type,
            'STARTED'
          )

          // Check balance
          await checkBalance(this.client.account!.address, step)

          // Create new transaction request
          if (!step.transactionRequest) {
            const { execution, ...stepBase } = step
            let updatedStep: LiFiStep
            if (isPermitStep) {
              const updatedRelayedStep = await getRelayerQuote({
                fromChain: stepBase.action.fromChainId,
                fromToken: stepBase.action.fromToken.address,
                fromAddress: stepBase.action.fromAddress!,
                fromAmount: stepBase.action.fromAmount,
                toChain: stepBase.action.toChainId,
                toToken: stepBase.action.toToken.address,
                slippage: stepBase.action.slippage,
                toAddress: stepBase.action.toAddress,
                allowBridges: [stepBase.tool],
              })
              updatedStep = {
                ...updatedRelayedStep.data.quote.step,
                id: stepBase.id,
              }
            } else {
              updatedStep = await getStepTransaction(stepBase)
            }
            const comparedStep = await stepComparison(
              this.statusManager,
              step,
              updatedStep,
              this.allowUserInteraction,
              this.executionOptions
            )
            Object.assign(step, {
              ...comparedStep,
              execution: step.execution,
            })
          }

          if (!step.transactionRequest) {
            throw new TransactionError(
              LiFiErrorCode.TransactionUnprepared,
              'Unable to prepare transaction.'
            )
          }

          let transactionRequest: TransactionParameters = {
            to: step.transactionRequest.to,
            from: step.transactionRequest.from,
            data: step.transactionRequest.data,
            value: step.transactionRequest.value
              ? BigInt(step.transactionRequest.value)
              : undefined,
            gas: step.transactionRequest.gasLimit
              ? BigInt(step.transactionRequest.gasLimit)
              : undefined,
            // gasPrice: step.transactionRequest.gasPrice
            //   ? BigInt(step.transactionRequest.gasPrice as string)
            //   : undefined,
            // maxFeePerGas: step.transactionRequest.maxFeePerGas
            //   ? BigInt(step.transactionRequest.maxFeePerGas as string)
            //   : undefined,
            maxPriorityFeePerGas:
              this.client.account?.type === 'local'
                ? await getMaxPriorityFeePerGas(this.client)
                : step.transactionRequest.maxPriorityFeePerGas
                  ? BigInt(step.transactionRequest.maxPriorityFeePerGas)
                  : undefined,
          }

          if (this.executionOptions?.updateTransactionRequestHook) {
            const customizedTransactionRequest: TransactionParameters =
              await this.executionOptions.updateTransactionRequestHook({
                requestType: 'transaction',
                ...transactionRequest,
              })

            transactionRequest = {
              ...transactionRequest,
              ...customizedTransactionRequest,
            }
          }

          // STEP 3: Send the transaction
          // Make sure that the chain is still correct
          const updatedClient = await this.checkClient(step, process)
          if (!updatedClient) {
            return step
          }

          process = this.statusManager.updateProcess(
            step,
            process.type,
            permitSupported ? 'PERMIT_REQUIRED' : 'ACTION_REQUIRED'
          )

          if (!this.allowUserInteraction) {
            return step
          }

          if (atomicBatchSupported) {
            const transferCall: Call = {
              chainId: fromChain.id,
              data: transactionRequest.data as Hex,
              to: transactionRequest.to as Address,
              value: transactionRequest.value,
            }

            calls.push(transferCall)

            txHash = (await getAction(
              this.client,
              sendCalls,
              'sendCalls'
            )({
              account: this.client.account!,
              calls,
            })) as Address
          } else {
            let permitSignature: PermitSignature | undefined
            if (permitSupported) {
              permitSignature = await signPermitMessage(this.client, {
                transactionRequest,
                chain: fromChain,
                tokenAddress: step.action.fromToken.address as Address,
                amount: BigInt(step.action.fromAmount),
                nativePermit,
                permitData: isPermitStep ? step.permitData : undefined,
                useWitness: isPermitStep,
              })

              transactionRequest.to = fromChain.permit2Proxy
              transactionRequest.data = permitSignature.data

              try {
                // Try to re-estimate the gas due to additional Permit data
                transactionRequest.gas = await estimateGas(this.client, {
                  account: this.client.account!,
                  to: transactionRequest.to as Address,
                  data: transactionRequest.data as Hex,
                  value: transactionRequest.value,
                })
              } catch {
                // Let the wallet estimate the gas in case of failure
                transactionRequest.gas = undefined
              }

              process = this.statusManager.updateProcess(
                step,
                process.type,
                'ACTION_REQUIRED'
              )
            }
            if (isPermitStep && permitSignature) {
              const relayedTransaction = await relayTransaction({
                tokenOwner: this.client.account!.address,
                chainId: fromChain.id,
                permit: step.permit,
                witness: step.witness,
                signedPermitData: permitSignature.signature,
                callData: transactionRequest.data!,
              })
              txHash = relayedTransaction.data.taskId
            } else {
              txHash = await getAction(
                this.client,
                sendTransaction,
                'sendTransaction'
              )({
                to: transactionRequest.to,
                account: this.client.account!,
                data: transactionRequest.data,
                value: transactionRequest.value,
                gas: transactionRequest.gas,
                gasPrice: transactionRequest.gasPrice,
                maxFeePerGas: transactionRequest.maxFeePerGas,
                maxPriorityFeePerGas: transactionRequest.maxPriorityFeePerGas,
              } as SendTransactionParameters)
            }
          }

          // STEP 4: Wait for the transaction
          process = this.statusManager.updateProcess(
            step,
            process.type,
            'PENDING',
            // When atomic batch is supported, txHash represents the batch hash rather than an individual transaction hash at this point
            atomicBatchSupported
              ? {
                  atomicBatchSupported,
                }
              : {
                  txHash: txHash,
                  txLink: `${fromChain.metamask.blockExplorerUrls[0]}tx/${txHash}`,
                }
          )
        }

        let transactionReceipt:
          | TransactionReceipt
          | WalletCallReceipt
          | undefined

        if (atomicBatchSupported) {
          transactionReceipt = await waitForBatchTransactionReceipt(
            this.client,
            txHash
          )
        } else if (isPermitStep) {
          transactionReceipt = await waitForRelayedTransactionReceipt(txHash)
        } else {
          transactionReceipt = await waitForTransactionReceipt({
            client: this.client,
            chainId: fromChain.id,
            txHash,
            onReplaced: (response) => {
              this.statusManager.updateProcess(step, process.type, 'PENDING', {
                txHash: response.transaction.hash,
                txLink: `${fromChain.metamask.blockExplorerUrls[0]}tx/${response.transaction.hash}`,
              })
            },
          })
        }

        // Update pending process if the transaction hash from the receipt is different.
        // This might happen if the transaction was replaced.
        if (
          transactionReceipt?.transactionHash &&
          transactionReceipt.transactionHash !== txHash
        ) {
          process = this.statusManager.updateProcess(
            step,
            process.type,
            'PENDING',
            {
              txHash: transactionReceipt.transactionHash,
              txLink: `${fromChain.metamask.blockExplorerUrls[0]}tx/${transactionReceipt.transactionHash}`,
            }
          )
        }

        if (isBridgeExecution) {
          process = this.statusManager.updateProcess(step, process.type, 'DONE')
        }
      } catch (e: any) {
        const error = await parseEVMErrors(e, step, process)
        process = this.statusManager.updateProcess(
          step,
          process.type,
          'FAILED',
          {
            error: {
              message: error.cause.message,
              code: error.code,
            },
          }
        )
        this.statusManager.updateExecution(step, 'FAILED')

        throw error
      }
    }

    // Wait for the transaction status on the destination chain
    if (isBridgeExecution) {
      process = this.statusManager.findOrCreateProcess({
        step,
        type: 'RECEIVING_CHAIN',
        status: 'PENDING',
        chainId: toChain.id,
      })
    }

    await waitForDestinationChainTransaction(
      step,
      process,
      this.statusManager,
      toChain
    )

    // DONE
    return step
  }
}
