/**
 * Shared, client-safe helpers for the studio create-collection wizard
 * (app/studio/[address]/create). Kept out of the components so the
 * chunking/naming/dep-list logic is independently testable and so the
 * wizard components stay focused on state + markup.
 *
 * See docs/pnd-collection-system.md, docs/injection-convention.md, and
 * contracts/src/collection/CollectionTypes.sol for the source-of-truth
 * shapes this mirrors.
 */

import { bytesToHex, keccak256, type Address } from "viem"
import { ETHFS_V2_FILE_STORAGE, SCRIPTY_STORAGE_V2, getAddressOrNull } from "@pin/addresses"
import { CodeKind, type CodeRef } from "./sovereign-collection"

export { CodeKind }

// ── presets ──────────────────────────────────────────────────────────────

export const PRESETS = ["edition", "generative", "renderer"] as const
export type Preset = (typeof PRESETS)[number]

export const PRESET_LABEL: Record<Preset, string> = {
  edition: "Edition",
  generative: "Generative",
  renderer: "Renderer native",
}

export const PRESET_DESCRIPTION: Record<Preset, string> = {
  edition: "Fixed artwork, priced mint. No code required.",
  generative: "Your script runs onchain, one output per token.",
  renderer: "A custom renderer contract is the artwork.",
}

// ── known onchain dependency libraries (v1) ─────────────────────────────

/**
 * Known gzipped library files already stored on the EthFS v2 file store,
 * offered as checkboxes in the GENERATIVE preset's dependency picker.
 *
 * Both entries are verified against the real mainnet EthFS store:
 * p5 via contracts/test/collection/renderers/GenerativeRendererFork.t.sol,
 * three.js via a direct getContent probe (407KB of content at exactly
 * "three-v0.147.0.min.js.gz", 2026-07-06). Any further library added to
 * this list must pass the same check: a non-empty getContent read at the
 * exact name, before it ships to artists.
 */
export const KNOWN_DEPENDENCIES: {
  id: string
  label: string
  file: string
  verified: boolean
}[] = [
  { id: "p5", label: "p5.js 1.5.0", file: "p5-v1.5.0.min.js.gz", verified: true },
  {
    id: "three",
    label: "three.js 0.147.0",
    file: "three-v0.147.0.min.js.gz",
    verified: true,
  },
]

// The scripty/EthFS contracts are chain-agnostic singletons; dev chains
// fork mainnet, so the mainnet entry is the fallback for chain ids without
// their own entry. Use these resolvers instead of raw getAddressOrNull for
// anything scripty-related.
export function scriptyStorageAddress(chainId: number) {
  return getAddressOrNull(SCRIPTY_STORAGE_V2, chainId) ?? getAddressOrNull(SCRIPTY_STORAGE_V2, 1)
}

export function ethfsStorageAddress(chainId: number) {
  return (
    getAddressOrNull(ETHFS_V2_FILE_STORAGE, chainId) ?? getAddressOrNull(ETHFS_V2_FILE_STORAGE, 1)
  )
}

export function dependencyCodeRef(file: string, chainId: number): CodeRef | null {
  const store = ethfsStorageAddress(chainId)
  return store ? { store, name: file, kind: CodeKind.ScriptGzip } : null
}

// ── liveness copy ────────────────────────────────────────────────────────

export const LIVENESS_OPTIONS: { value: 0 | 1 | 2; label: string; help: string }[] = [
  {
    value: 0,
    label: "Pure",
    help: "Same seed, same output, forever. No time, no network, no external reads.",
  },
  {
    value: 1,
    label: "Onchain live",
    help: "May read chain state at render time (declare the reads in render params).",
  },
  {
    value: 2,
    label: "External live",
    help: "Reads declared offchain sources. Honest about being fragile over time.",
  },
]

// ── naming ───────────────────────────────────────────────────────────────

/** Lowercase, hyphenated, alnum-only slug for a collection name. */
export function slugify(name: string): string {
  const s = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
  return s || "untitled"
}

/**
 * The ScriptyStorage content name for an artist's generative script:
 * `pnd-<artist address>-<slug>-v<n>`. Namespaced by artist address so two
 * artists can pick the same title without colliding on the shared
 * ScriptyStorageV2 contract's global `contents` name mapping. The version
 * suffix bumps on a name collision (see `nextAvailableContentName`) rather
 * than ever reusing/overwriting a name — ScriptyStorage content is
 * append-only per name and a collision means "something is already stored
 * there", not necessarily this artist's own prior attempt.
 */
export function contentName(artist: Address, slug: string, version: number): string {
  return `pnd-${artist.toLowerCase()}-${slug}-v${version}`
}

// ── chunking ─────────────────────────────────────────────────────────────

/**
 * Byte size of each addChunkToContent call. Chosen well under the ~24KB
 * contract code-size ceiling and typical calldata/gas comfort zone for a
 * single wallet-confirmed write; matches the task spec's ~15000-byte target.
 */
export const CHUNK_SIZE_BYTES = 15_000

/** Split UTF-8 script bytes into fixed-size chunks, in upload order. */
export function chunkScript(bytes: Uint8Array, chunkSize = CHUNK_SIZE_BYTES): Uint8Array[] {
  const chunks: Uint8Array[] = []
  for (let i = 0; i < bytes.length; i += chunkSize) {
    chunks.push(bytes.slice(i, i + chunkSize))
  }
  // An empty script still needs at least a zero-length placeholder chunk
  // so `contents(name).size` reflects "created" rather than "created but
  // never touched" — but in practice the wizard requires non-empty code
  // before reaching the upload step, so this only guards against a
  // theoretical empty-string submit.
  return chunks.length > 0 ? chunks : [new Uint8Array(0)]
}

/** UTF-8 encode the artist's script (RAW JS — v1 never gzips artist code). */
export function scriptBytes(source: string): Uint8Array {
  return new TextEncoder().encode(source)
}

/** keccak256 of the script bytes, for WorkConfig.codeHash. */
export function scriptCodeHash(bytes: Uint8Array): `0x${string}` {
  return keccak256(bytes)
}

/** bytes -> 0x hex, for addChunkToContent's `bytes` calldata arg. */
export function toHexChunk(bytes: Uint8Array): `0x${string}` {
  return bytesToHex(bytes)
}
