import type { Address, Hex } from "viem"

export type JsonPrimitive = null | boolean | number | string
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue }

export type TruthClass = "protocol" | "indexed" | "artist" | "editorial"

export type Evidence = {
  truth: TruthClass
  source: string
  observedAt?: string
  blockNumber?: string
  finalizedThrough?: string
  coverage?: {
    fromBlock?: string
    throughBlock?: string
    complete: boolean
    gaps?: string[]
  }
}

export type ProviderResult<T> =
  | { status: "available"; value: T; evidence: Evidence }
  | { status: "partial"; value: T; missing: string[]; evidence: Evidence }
  | { status: "unavailable"; reason: string; retryable: boolean }
  | { status: "unsupported"; reason: string }

export type CapabilityState =
  | { status: "supported"; adapter: string }
  | { status: "unsupported"; reason: string }
  | { status: "unavailable"; reason: string; retryable: boolean }
  | { status: "partial"; reason: string; available: string[] }
  | { status: "incompatible"; reason: string }

export type PortableMediaRef = {
  uri: string
  mediaType?: string
  sha256?: string
  width?: number
  height?: number
  alt?: string
}

export type ArtistLink = {
  label: string
  url: string
}

export type ReleaseAdapterBinding = {
  capability: string
  adapter: string
  target: "collection" | "primary-minter" | "collection-renderer" | Address
  config?: Record<string, JsonValue>
}

export type ManifestAuthorshipV1 = {
  scheme: "eip712"
  signer: Address
  issuedAt: string
  digest: Hex
  signature: Hex
}

export type ReleaseManifestV1 = {
  spec: "pnd.release"
  version: 1
  release: {
    id: string
    chain: {
      namespace: "eip155"
      reference: string
    }
    collection: Address
    protocol: {
      family: "surface"
      abi: string
      factory?: Address
    }
  }
  declaration: {
    artist: Address
    title: string
    summary?: string
    statement?: string
    process?: string
    announcedSchedule?: {
      opensAt?: string
      closesAt?: string
      note?: string
    }
    media?: {
      cover?: PortableMediaRef
      hero?: PortableMediaRef
      process?: PortableMediaRef[]
      social?: PortableMediaRef[]
    }
    links?: ArtistLink[]
  }
  presentation?: {
    layout?: "default" | "edition" | "generative" | "custom"
    theme?: {
      accent?: string
      background?: string
      foreground?: string
      font?: string
    }
    aspectRatio?: string
  }
  capabilities: {
    required: string[]
    optional?: string[]
    adapters: ReleaseAdapterBinding[]
  }
  extensions?: Record<string, JsonValue>
  authorship?: ManifestAuthorshipV1
}

export type UnsignedReleaseManifestV1 = Omit<ReleaseManifestV1, "authorship">

export type ArtistSiteDeclarationV1 = {
  spec: "pnd.artist-site"
  version: 1
  chain: { namespace: "eip155"; reference: string }
  artist: Address
  url: string
  collections?: Address[]
  kit?: { name: string; version: string }
  issuedAt: string
  expiresAt?: string
  nonce: Hex
  signature: Hex
}
