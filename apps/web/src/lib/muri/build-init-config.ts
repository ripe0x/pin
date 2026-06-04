import { buildPermissionFlags } from "./permissions.ts"

/**
 * MURI display modes (mirrors IMURIProtocol.DisplayMode).
 * DIRECT_FILE renders the selected artwork as a static file; HTML renders
 * the on-chain viewer that fetches each fallback URI, verifies the SHA-256
 * hash, and shows the first surviving copy.
 */
export const DISPLAY_MODE = { DIRECT_FILE: 0, HTML: 1 } as const

export type MuriAttribute = { trait_type: string; value: string | number }

export type BuildInitConfigInput = {
  name: string
  description: string
  attributes?: MuriAttribute[]
  /** Ordered fallback URIs for the artwork (e.g. one CID across N gateways). */
  artworkUris: string[]
  mimeType: string
  /** SHA-256 of the artwork bytes (0x-prefixed). */
  fileHash: string
  /** Whether the artwork is interactive/animated (goes in animation_url). */
  isAnimationUri?: boolean
  /** Ordered thumbnail URIs (off-chain). Defaults to the artwork URIs. */
  thumbnailUris?: string[]
  displayMode?: number
  allowCollectorFallbacks?: boolean
}

/**
 * Build the JSON metadata BODY MURI stores. renderMetadata wraps this in
 * `{ ... }` and appends `image` / `animation_url` itself, so we pass only
 * the inner fields (name, description, attributes) with no outer braces.
 */
export function buildMetadataBody(
  name: string,
  description: string,
  attributes: MuriAttribute[] = [],
): string {
  const obj: Record<string, unknown> = { name, description }
  if (attributes.length > 0) obj.attributes = attributes
  // Strip the outer braces — JSON.stringify handles all escaping.
  return JSON.stringify(obj).slice(1, -1)
}

export type MuriInitConfig = {
  metadata: string
  artwork: {
    artistUris: string[]
    collectorUris: string[]
    mimeType: string
    fileHash: string
    isAnimationUri: boolean
    selectedArtistUriIndex: bigint
  }
  thumbnail: {
    kind: number // 0 ON_CHAIN, 1 OFF_CHAIN
    onChain: { mimeType: string; chunks: readonly `0x${string}`[]; zipped: boolean }
    offChain: { uris: string[]; selectedUriIndex: bigint }
  }
  displayMode: number
  permissions: { flags: number }
  htmlTemplate: { chunks: readonly `0x${string}`[]; zipped: boolean }
}

/**
 * Build a fully off-chain MURI InitConfig (v1): artwork + thumbnail by URI,
 * default on-chain HTML viewer (empty htmlTemplate chunks), full artist
 * permissions, collectors may add fallbacks. The matching mint call passes
 * empty `thumbnailChunks` and `htmlTemplateChunks` (no SSTORE2).
 */
export function buildInitConfig(input: BuildInitConfigInput): MuriInitConfig {
  const thumbnailUris = input.thumbnailUris ?? input.artworkUris
  return {
    metadata: buildMetadataBody(input.name, input.description, input.attributes),
    artwork: {
      artistUris: input.artworkUris,
      collectorUris: [],
      mimeType: input.mimeType,
      fileHash: input.fileHash,
      isAnimationUri: input.isAnimationUri ?? false,
      selectedArtistUriIndex: 0n,
    },
    thumbnail: {
      kind: 1, // OFF_CHAIN
      onChain: { mimeType: "", chunks: [], zipped: false },
      offChain: { uris: thumbnailUris, selectedUriIndex: 0n },
    },
    displayMode: input.displayMode ?? DISPLAY_MODE.HTML,
    permissions: {
      flags: buildPermissionFlags({
        allowCollectorFallbacks: input.allowCollectorFallbacks,
      }),
    },
    htmlTemplate: { chunks: [], zipped: false },
  }
}
