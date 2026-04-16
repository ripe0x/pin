/**
 * Shared types for IPFS pinning providers.
 *
 * All providers implement PinningProvider so the UI can treat them uniformly.
 * Artists bring their own API keys (BYOK) — keys are stored in localStorage
 * and passed per-request, never persisted server-side.
 */

export type PinStatus = "pinned" | "pinning" | "queued" | "failed" | "unknown"

export type PinResult = {
  cid: string
  status: PinStatus
}

export type ProviderInfo = {
  id: ProviderType
  name: string
  description: string
  signupUrl: string
  freeTier: string
  keyPlaceholder: string
  keyGuide: string
  disabled?: boolean
}

export type ProviderType = "pinata" | "web3storage" | "filebase"

export interface PinningProvider {
  readonly name: string
  readonly type: ProviderType

  /** Pin an existing CID (no re-upload — the data is already on IPFS). */
  pinByCid(cid: string, name?: string): Promise<PinResult>

  /** Check if a CID is already pinned by this provider. */
  checkPin(cid: string): Promise<PinStatus>

  /** Validate that the API key is correct. */
  validateKey(): Promise<boolean>
}

export const PROVIDER_INFO: Record<ProviderType, ProviderInfo> = {
  pinata: {
    id: "pinata",
    name: "Pinata",
    description: "The most popular IPFS pinning service. Easy to use, reliable.",
    signupUrl: "https://app.pinata.cloud/register",
    freeTier: "500 pins / 1 GB free",
    keyPlaceholder: "Pinata JWT token",
    keyGuide: "Create a new API key in your Pinata dashboard. You can use an Admin key, or customize permissions: under Legacy Endpoints, enable \"pinByHash\" (in Pinning) and \"pinList\" (in Data). V3 Resources are not needed.",
  },
  web3storage: {
    id: "web3storage",
    name: "web3.storage",
    description: "Currently unavailable — web3.storage's legacy API is in maintenance mode.",
    signupUrl: "https://web3.storage",
    freeTier: "5 GB free",
    keyPlaceholder: "web3.storage API token",
    keyGuide: "web3.storage's pinning API is currently offline. Please use Pinata or Filebase instead.",
    disabled: true,
  },
  filebase: {
    id: "filebase",
    name: "Filebase",
    description: "S3-compatible IPFS pinning with a generous free tier.",
    signupUrl: "https://filebase.com",
    freeTier: "5 GB free",
    keyPlaceholder: "Filebase access token",
    keyGuide: "Go to Access Keys in your Filebase dashboard and create a new key. The default key permissions are sufficient.",
  },
}
