import type { PinningProvider, ProviderType } from "./types"
import { PinataProvider } from "./pinata"
import { Web3StorageProvider } from "./web3storage"
import { FilebaseProvider } from "./filebase"
import { FourEverlandProvider } from "./4everland"

export type { PinningProvider, PinResult, PinStatus, ProviderType } from "./types"
export { PROVIDER_INFO } from "./types"

/**
 * Create a pinning provider instance from a type and API key.
 */
export function createProvider(
  type: ProviderType,
  apiKey: string,
): PinningProvider {
  switch (type) {
    case "pinata":
      return new PinataProvider(apiKey)
    case "web3storage":
      return new Web3StorageProvider(apiKey)
    case "filebase":
      return new FilebaseProvider(apiKey)
    case "4everland":
      return new FourEverlandProvider(apiKey)
  }
}
