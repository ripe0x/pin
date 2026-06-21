/**
 * Mint collection registry — client-safe descriptors for the generic ERC-721
 * mint surface (`/mint/[contract]`).
 *
 * Each entry tells the generic UI + reads how to talk to one standard ERC-721
 * with a standard mint function: how to read price/supply/window, how to gate
 * (one-per-wallet), how to write the mint, and how to render its art. Adding
 * another collection that follows this shape is a new entry here — not new
 * components. The first entry is **Vouch** (cubes-witness): a no-arg,
 * one-per-wallet, 24h-window mint of an onchain-generative seat, with a shared
 * aggregate "cube" as the collection hero and a post-mint seat lifecycle.
 *
 * No server-only imports: this module is consumed by both server reads
 * (`mint-onchain.ts`, the route pages) and client components (`MintPanel`).
 */
import { type Abi, type Address, isAddress } from "viem"
import { vouchAbi, cubeRendererAbi } from "@pin/abi"

// Mirror the fork/mainnet split used by the editions + tx-ui code. In fork mode
// the chain is the wagmi `forkChain` (id 31339) so wallet/network checks agree;
// otherwise Ethereum mainnet. NEXT_PUBLIC_* is inlined at build time.
const FORK_MODE = process.env.NEXT_PUBLIC_USE_LOCAL_RPC === "1"
// Honors the same NEXT_PUBLIC_FORK_CHAIN_ID override as wagmi.ts (default 31339).
const FORK_CHAIN_ID = Number(process.env.NEXT_PUBLIC_FORK_CHAIN_ID || "31339")
export const MINT_CHAIN_ID = FORK_MODE ? FORK_CHAIN_ID : 1

// ── descriptor shape ────────────────────────────────────────────────────────

/** Unit price per token. */
export type PriceSource =
  | { kind: "getter"; fn: string } // read a uint256 wei price getter, e.g. MINT_PRICE()
  | { kind: "const"; wei: bigint }

/** Supply ceiling. */
export type CapSource =
  | { kind: "getter"; fn: string } // read a uint256 cap getter, e.g. MAX_SUPPLY()
  | { kind: "const"; value: bigint }
  | { kind: "open" } // uncapped

/** Mint window. */
export type WindowSource =
  | { kind: "start-duration"; startFn: string; durationSec: number }
  | { kind: "start-end"; startFn: string; endFn: string }
  | { kind: "start-only"; startFn: string } // Vouch: opens at start, no time close (supply-capped)
  | { kind: "open" } // always open

/** Where the collection-level hero artwork comes from. */
export type HeroSource =
  | {
      // Render a separate view contract's tokenURI (Vouch's shared cube).
      kind: "renderer-contract"
      address: Address
      abi: Abi
      fn: string
      tokenId: bigint
    }
  | { kind: "token-uri"; tokenId: bigint } // decode the collection's own tokenURI(tokenId)
  | { kind: "static"; url: string }

/** Optional post-mint seat lifecycle (Vouch). */
export type MintLifecycle = {
  renewFn: string // renew(tokenId): free, owner-only, keeps the active clock alive
  claimFn: string // claim(tokenId): payable, reclaims a lapsed seat at the mint price
  activeFn: string // isActive(tokenId) -> bool
  expiresFn: string // expiresAt(tokenId) -> uint (unix seconds)
  freshnessFn: string // freshnessBps(tokenId) -> uint16 (0..10000)
}

export type MintCollection = {
  slug: string
  name: string
  description?: string
  chainId: number
  address: Address
  abi: Abi
  // reads
  mintedFn: string // total-minted counter, e.g. totalMinted()
  cap: CapSource
  price: PriceSource
  window: WindowSource
  alreadyMintedFn: string | null // hasMinted(addr) -> bool; null when repeatable
  // write
  mintFn: string // e.g. "mint"
  quantity: boolean // true: quantity selector + value = price * qty; false: single, value = price
  // presentation
  layout: "shared-aggregate" | "standard"
  hero: HeroSource
  /** Shared aggregate stat block source (Vouch cube getters). */
  aggregate?: { address: Address; abi: Abi }
  lifecycle?: MintLifecycle
  /** Noun for one token in UI copy ("seat", "piece", "token"). */
  tokenNoun: string
  /** CSS aspect-ratio for the collection hero / per-piece art (defaults square). */
  heroAspect?: string
  pieceAspect?: string
}

// ── env-driven addresses ─────────────────────────────────────────────────────

// Vouch (cubes-witness). Addresses come from env so the UI builds/tests against
// a local fork and flips to mainnet once the collection is deployed. The
// descriptor is only registered when the core addresses are present + valid.
//
// IMPORTANT: these must be LITERAL `process.env.NEXT_PUBLIC_*` reads. Next/
// turbopack statically replaces only literal references in the client bundle;
// a dynamic `process.env[name]` lookup stays undefined on the client, which
// silently drops the descriptor (and the mint CTA) after hydration.
const VOUCH_ADDRESS = process.env.NEXT_PUBLIC_VOUCH_ADDRESS
const VOUCH_CUBE_RENDERER = process.env.NEXT_PUBLIC_VOUCH_CUBE_RENDERER
const VOUCH_RENDERED_TOKEN_ID = BigInt(process.env.NEXT_PUBLIC_VOUCH_RENDERED_TOKEN_ID || "52")

function vouchCollection(): MintCollection | null {
  if (!VOUCH_ADDRESS || !isAddress(VOUCH_ADDRESS)) return null
  if (!VOUCH_CUBE_RENDERER || !isAddress(VOUCH_CUBE_RENDERER)) return null
  const cube = VOUCH_CUBE_RENDERER as Address
  return {
    slug: "vouch",
    name: "Vouch",
    description:
      "Each Vouch is a 52-day seat in a shared onchain cube. Owning one places a unique contour in the artwork; let it lapse and anyone can reclaim the seat.",
    chainId: MINT_CHAIN_ID,
    address: VOUCH_ADDRESS as Address,
    abi: vouchAbi as unknown as Abi,
    mintedFn: "totalMinted",
    cap: { kind: "getter", fn: "MAX_SUPPLY" },
    price: { kind: "getter", fn: "mintPrice" },
    window: { kind: "start-only", startFn: "mintStart" },
    alreadyMintedFn: "hasMinted",
    mintFn: "mint",
    quantity: false,
    layout: "shared-aggregate",
    hero: {
      kind: "renderer-contract",
      address: cube,
      abi: cubeRendererAbi as unknown as Abi,
      fn: "tokenURI",
      tokenId: VOUCH_RENDERED_TOKEN_ID,
    },
    aggregate: { address: cube, abi: cubeRendererAbi as unknown as Abi },
    lifecycle: {
      renewFn: "renew",
      claimFn: "claim",
      activeFn: "isActive",
      expiresFn: "expiresAt",
      freshnessFn: "freshnessBps",
    },
    tokenNoun: "seat",
    heroAspect: "1 / 1", // CubeRenderer viewBox (520×520, square)
    pieceAspect: "1 / 1", // VouchRenderer viewBox (200×200, square)
  }
}

// ── registry + resolver ──────────────────────────────────────────────────────

export const MINT_COLLECTIONS: MintCollection[] = [vouchCollection()].filter(
  (c): c is MintCollection => c !== null,
)

/** Resolve a `/mint/[contract]` segment — either a slug or a contract address. */
export function resolveMintCollection(idOrAddress: string): MintCollection | null {
  const key = idOrAddress.toLowerCase()
  return (
    MINT_COLLECTIONS.find((c) => c.slug.toLowerCase() === key) ??
    MINT_COLLECTIONS.find((c) => c.address.toLowerCase() === key) ??
    null
  )
}
