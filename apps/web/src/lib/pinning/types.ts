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

// Order matters — ProviderSelect renders these in object-key order,
// and PinningSetup defaults to the first non-disabled entry.
export const PROVIDER_INFO: Record<ProviderType, ProviderInfo> = {
  filebase: {
    id: "filebase",
    name: "Filebase",
    description: "Free, decentralized IPFS pinning. Recommended for most artists.",
    signupUrl: "https://console.filebase.com/signup",
    freeTier: "5 GB free",
    keyPlaceholder: "Filebase IPFS Pinning Service token",
    keyGuide: "Important: you need the IPFS Pinning Service token, NOT a regular S3 access key. Steps: (1) Sign up at filebase.com. (2) Create a new bucket — make sure the Network is set to IPFS (not S3). (3) Go to console.filebase.com/keys and scroll to the \"IPFS Pinning Service API Endpoint\" section. (4) In the \"Choose Bucket to Generate Token\" dropdown, pick the IPFS bucket you just created. (5) Copy the generated token and paste it here.",
  },
  pinata: {
    id: "pinata",
    name: "Pinata",
    description: "Reliable, but requires the Picnic plan ($20/mo) or higher for Pin by CID. Free plan cannot pin existing IPFS content.",
    signupUrl: "https://app.pinata.cloud/register",
    freeTier: "Paid plan required",
    keyPlaceholder: "Pinata JWT token",
    keyGuide: "Heads up: Pinata's Free plan does NOT support Pin by CID (you'll get errors even with admin permissions). You need the Picnic plan ($20/mo) or higher. If you'd rather not pay, use Filebase instead. To create the key: in your Pinata dashboard create a new API key. Use an Admin key, or customize permissions: under Legacy Endpoints, enable \"pinByHash\" (in Pinning) and \"pinList\" (in Data).",
  },
  web3storage: {
    id: "web3storage",
    name: "web3.storage",
    description: "Currently unavailable — web3.storage's legacy API is in maintenance mode.",
    signupUrl: "https://web3.storage",
    freeTier: "5 GB free",
    keyPlaceholder: "web3.storage API token",
    keyGuide: "web3.storage's pinning API is currently offline. Please use Filebase or Pinata instead.",
    disabled: true,
  },
}
