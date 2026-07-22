/**
 * Mint collection registry — client-safe descriptors for the generic ERC-721
 * mint surface (`/mint/[contract]`).
 *
 * Each entry tells the generic UI + reads how to talk to one standard ERC-721
 * with a standard mint function: how to read price/supply/window, how to gate
 * (one-per-wallet), how to write the mint, and how to render its art. Adding
 * another collection that follows this shape is a new entry here — not new
 * components. The first entry is **Vouch** (cubes-witness): a one-per-wallet,
 * chosen-seat `mint(uint256 tokenId)` of an onchain-generative seat, with a
 * shared aggregate "cube" as the collection hero and a post-mint seat
 * lifecycle. Vouch's seat choice flows through the generic selector + args-
 * builder machinery (mint-slots.tsx / mint-registries.ts).
 *
 * No server-only imports: this module is consumed by both server reads
 * (`mint-onchain.ts`, the route pages) and client components (`MintPanel`).
 */
import { type Abi, type Address, isAddress } from "viem"
import { vouchAbi, cubeRendererAbi } from "@pin/abi"
import type { MintPhase } from "./mint-phases"
import { registerArgsBuilder } from "./mint-registries"
import type { RevealSource } from "./mint-reveal"
// Homage module: importing it registers the homage-* quote/eligibility/args
// providers at module scope (the side-effect pattern mint-registries.ts
// documents); the factory contributes the descriptor below.
import { homageCollection } from "./mint-modules/homage"

export type { MintPhase } from "./mint-phases"
export type { RevealSource } from "./mint-reveal"

// Mirror the fork/mainnet split used by the editions + tx-ui code. In fork mode
// the chain is the wagmi `forkChain` (id 31339) so wallet/network checks agree;
// otherwise Ethereum mainnet. NEXT_PUBLIC_* is inlined at build time.
const FORK_MODE = process.env.NEXT_PUBLIC_USE_LOCAL_RPC === "1"
// Honors the same NEXT_PUBLIC_FORK_CHAIN_ID override as wagmi.ts (default 31339).
const FORK_CHAIN_ID = Number(process.env.NEXT_PUBLIC_FORK_CHAIN_ID || "31339")
// Opt-in sepolia instance (chain 11155111) for running the Homage mint surface
// against a live testnet deployment instead of a local fork. Mutually exclusive
// with FORK_MODE; a no-op when unset, so mainnet production stays byte-identical.
const USE_SEPOLIA = process.env.NEXT_PUBLIC_USE_SEPOLIA === "1"
const SEPOLIA_CHAIN_ID = 11155111
export const MINT_CHAIN_ID = FORK_MODE ? FORK_CHAIN_ID : USE_SEPOLIA ? SEPOLIA_CHAIN_ID : 1

// ── descriptor shape ────────────────────────────────────────────────────────

/** Unit price per token. */
export type PriceSource =
  | { kind: "getter"; fn: string } // read a uint256 wei price getter, e.g. MINT_PRICE()
  | { kind: "const"; wei: bigint }
  // Dynamic pricing resolved client-side through the quote-provider registry
  // (mint-registries.ts) — e.g. a v4 quoter probe for a swap-backed mint. The
  // server snapshot carries no price ("0"); MintPanel fetches the quote with a
  // visibility-gated refresh (mint-hooks.ts) and uses its value as msg.value.
  | { kind: "quote"; provider: string }

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

/**
 * Optional per-token lifecycle READ fns (Vouch's seat clock). These enrich
 * `getPieceToken` server-side (active/expires/freshness in one multicall).
 * The lifecycle UI itself is no longer derived from this shape — the token
 * page renders whatever panel component the collection registered under
 * `lifecyclePanel` (mint-slots.tsx), so a collection can ship a panel (e.g. a
 * redeem flow) without these getters existing at all.
 */
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
  /**
   * Optional separate contract for TOKEN-level reads — `ownerOf`, `tokenURI`,
   * `balanceOf`, and the `Transfer` event a reveal watches. Most collections
   * are one contract, so `address`/`abi` cover both the mint write AND the
   * token reads and this stays unset. Set it when the collection is a
   * SOVEREIGN two-contract protocol where `address` is the mint engine
   * (writes, economics, schedule) and the ERC-721 itself is a separate
   * contract (Homage: `address` = HomageMinter, `tokenContract` = the pooled
   * PND Collection). Every token-level read in mint-onchain.ts / the mint
   * engine's reveal extraction falls back to `{ address, abi }` when this is
   * absent, so single-contract collections (Vouch) are unaffected.
   */
  tokenContract?: { address: Address; abi: Abi }
  // reads
  mintedFn: string // total-minted counter, e.g. totalMinted()
  cap: CapSource
  price: PriceSource
  window: WindowSource
  /**
   * Phased schedule (claim → allowlist → public). When present it SUPERSEDES
   * the single `window` (set `window: { kind: "open" }` for clarity): the
   * snapshot reads every phase's start/end getter in the same multicall, and
   * MintPanel drives status/mintFn/args/price from the resolved active phase.
   * See mint-phases.ts for the window semantics (0 = unscheduled, a phase
   * ends where the next begins, last phase open-ended).
   */
  phases?: MintPhase[]
  alreadyMintedFn: string | null // hasMinted(addr) -> bool; null when repeatable
  // write
  mintFn: string // e.g. "mint" (phased collections: per-phase mintFn wins)
  quantity: boolean // true: quantity selector + value = price * qty; false: single, value = price
  /**
   * Collection-level provider keys for non-phased mints — same registries as
   * the per-phase keys (mint-registries.ts / mint-slots.tsx); when `phases`
   * is present the active phase's own keys take precedence. Vouch uses
   * argsBuilder + selector for its chosen-seat `mint(uint256 tokenId)`.
   */
  eligibility?: string
  argsBuilder?: string
  selector?: string
  /**
   * Post-mint reveal: how to pull the drawn tokenId out of the mint receipt
   * so the success state can link to `/mint/[contract]/[tokenId]`. Omit for
   * no reveal step (Vouch: seat id is the wallet's choice-free next slot and
   * the shared cube is the artwork — nothing to reveal).
   */
  reveal?: RevealSource
  // presentation
  layout: "shared-aggregate" | "standard"
  /**
   * Key into the curated-layout registry (components/mint/curated-layouts.tsx).
   * When set, `/mint/[contract]` delegates the ENTIRE page body to the
   * registered component — the server still fetches the standard data
   * (snapshot, hero art, selector context) and passes it through, and
   * generateMetadata/OG are unchanged. Unset = the standard surface. Site
   * chrome for these pages is the separate lean map in curated-chrome.ts
   * (kept in sync by curated-chrome.test.ts).
   */
  customLayout?: string
  hero: HeroSource
  /**
   * Whether the hero art's decoded tokenURI metadata (name/description) may
   * retitle the collection page. Default true (Vouch: the shared cube's
   * onchain metadata IS the collection identity). Set false when the hero is
   * just a representative token render (Homage: a sample punk) whose own
   * name would mislabel the page.
   */
  identityFromHero?: boolean
  /** Shared aggregate stat block source (Vouch cube getters). */
  aggregate?: { address: Address; abi: Abi }
  lifecycle?: MintLifecycle
  /**
   * Key into the lifecycle-panel component registry (mint-slots.tsx). The
   * token page renders the registered panel for this collection; unset = no
   * per-token action panel.
   */
  lifecyclePanel?: string
  /** Noun for one token in UI copy ("seat", "piece", "token"). */
  tokenNoun: string
  /**
   * How the minted/cap counter reads. "outstanding" is the churn-aware label
   * for collections where a burn/redeem returns ids to the mintable pool
   * ("N of M outstanding" — the count can go down). Default "minted".
   */
  supplyLabel?: "minted" | "outstanding"
  /**
   * When set, tokenURI reads for this collection are treated as LIVE: served
   * through short-TTL pgCache at this TTL and never persisted as canonical
   * (the art re-renders when underlying onchain state changes). Token page
   * reads use `ttlSec` directly; the gallery grid uses a longer multiple —
   * status-color staleness in a grid is an accepted tradeoff.
   */
  liveMetadata?: { ttlSec: number }
  /** CSS aspect-ratio for the collection hero / per-piece art (defaults square). */
  heroAspect?: string
  pieceAspect?: string
  /**
   * Which indexer read-family backs this collection's record surfaces
   * (provenance timeline, indexer-first supply/schedule, gallery id list,
   * wallet-owned discovery). A keyed string — NOT hardcoded per-page — so the
   * token/collection pages stay collection-agnostic and a new indexed
   * collection is one descriptor field + one query module. Only "homage"
   * exists today (lib/homage-queries.ts). Absent = no indexer record surfaces
   * (the RPC/cached-reads-only path Vouch uses). Every read degrades to the
   * RPC snapshot when the tables are missing/empty, so setting this before the
   * indexer deploys is safe.
   */
  provenanceSource?: "homage"
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

// Vouch's mint takes the CHOSEN seat id — `mint(uint256 tokenId)`, "every
// Vouch is a chosen voxel", no lowest-available overload. The seat comes from
// the VouchSeatPicker selector (registered in mint-slots.tsx under the same
// key); this builder just validates and shapes it into calldata.
registerArgsBuilder("vouch-seat", ({ selection }) => {
  const seat = typeof selection === "number" && Number.isInteger(selection) ? selection : null
  if (seat === null || seat < 1) throw new Error("Pick an open seat first")
  return [BigInt(seat)]
})

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
    mintFn: "mint", // mint(uint256 tokenId) — args from the vouch-seat builder
    quantity: false,
    argsBuilder: "vouch-seat",
    selector: "vouch-seat",
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
    // Registered in mint-slots.tsx → SeatLifecyclePanel (renew/claim UI).
    lifecyclePanel: "vouch-seat",
    tokenNoun: "seat",
    heroAspect: "1 / 1", // CubeRenderer viewBox (520×520, square)
    pieceAspect: "1 / 1", // VouchRenderer viewBox (200×200, square)
  }
}

// ── registry + resolver ──────────────────────────────────────────────────────

export const MINT_COLLECTIONS: MintCollection[] = [
  vouchCollection(),
  homageCollection(MINT_CHAIN_ID),
].filter((c): c is MintCollection => c !== null)

/** Resolve a `/mint/[contract]` segment — either a slug or a contract address. */
export function resolveMintCollection(idOrAddress: string): MintCollection | null {
  const key = idOrAddress.toLowerCase()
  return (
    MINT_COLLECTIONS.find((c) => c.slug.toLowerCase() === key) ??
    MINT_COLLECTIONS.find((c) => c.address.toLowerCase() === key) ??
    null
  )
}
