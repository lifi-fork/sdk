import type { LiFiStep } from '@lifi/types'
import { isAddress, type WalletClient } from 'viem'
import type { StepExecutorOptions } from '../execution/BaseStepExecutor.js'
import { EVMStepExecutor } from '../execution/EVMStepExecutor.js'
import type { SDKProvider } from './types.js'
import { ProviderType } from './types.js'

export interface EVMProviderOptions {
  getWalletClient: () => Promise<WalletClient>
}

export interface EVMProvider extends SDKProvider {
  setOptions(options: EVMProviderOptions): void
}

export function EVM(options?: EVMProviderOptions): EVMProvider {
  let getWalletClient = options?.getWalletClient
  return {
    get type() {
      return ProviderType.EVM
    },
    isProviderStep(step: LiFiStep): boolean {
      const isProviderStep = isAddress(step.action.fromAddress!)
      return isProviderStep
    },
    async getStepExecutor(
      options: StepExecutorOptions
    ): Promise<EVMStepExecutor> {
      if (!getWalletClient) {
        throw new Error(`getWalletClient is not provided.`)
      }

      const walletClient = await getWalletClient()

      const executor = new EVMStepExecutor({ walletClient, ...options })

      return executor
    },
    setOptions(options: EVMProviderOptions) {
      getWalletClient = options.getWalletClient
    },
  }
}

export function isEVM(provider: SDKProvider): provider is EVMProvider {
  return provider.type === ProviderType.EVM
}
