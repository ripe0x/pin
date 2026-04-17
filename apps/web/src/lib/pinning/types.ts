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
    description: "Reliable IPFS pinning. Note: requires the Picnic plan ($20/mo) or higher for Pin by CID — the Free plan cannot pin existing IPFS content.",
    signupUrl: "https://app.pinata.cloud/register",
    freeTier: "Paid plan required for Pin by CID",
    keyPlaceholder: "Pinata JWT token",
    keyGuide: "Heads up: Pinata's Free plan does NOT support Pin by CID — you'll get errors even with admin permissions. You need the Picnic plan ($20/mo) or higher. To create the key: in your Pinata dashboard create a new API key. Use an Admin key, or customize permissions: under Legacy Endpoints, enable \"pinByHash\" (in Pinning) and \"pinList\" (in Data).",
  },
  filebase: {
    id: "filebase",
    name: "Filebase",
    description: "Not currently offered — guide is kept for future use.",
    signupUrl: "https://console.filebase.com/signup",
    freeTier: "5 GB free",
    keyPlaceholder: "Filebase IPFS Pinning Service token",
    keyGuide: "Filebase is not currently exposed in the UI.",
    disabled: true,
  },
  web3storage: {
    id: "web3storage",
    name: "web3.storage",
    description: "Currently unavailable — web3.storage's legacy API is in maintenance mode.",
    signupUrl: "https://web3.storage",
    freeTier: "5 GB free",
    keyPlaceholder: "web3.storage API token",
    keyGuide: "web3.storage's pinning API is currently offline.",
    disabled: true,
  },
}
