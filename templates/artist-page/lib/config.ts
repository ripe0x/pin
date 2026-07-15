/**
 * Typed config sourced from `NEXT_PUBLIC_*` env vars.
 *
 * Two values are required (artist address + name); everything else is
 * optional and the page falls back to sensible defaults.
 *
 * This module is import-safe in both server and client code — no fs, no
 * server-only deps. The artist's wallet address is used to derive their
 * SovereignAuctionHouse on first read; we don't need it baked at build time.
 */
import { isAddress, type Address } from "viem"

const ZERO = "0x0000000000000000000000000000000000000000" as const

// SovereignAuctionHouseFactory mainnet deploy address — locked.
// (Vendored from packages/addresses/src/index.ts in the foundation monorepo.)
export const SOVEREIGN_FACTORY_ADDRESS: Address =
  "0xaE712abcA452901A74D1FBC0c3919F2cc060EF9f"

// Earliest block the factory existed. Bounding `getLogs` here cuts ~24M
// blocks of empty scanning per cold load, since no house could have
// existed before the factory was deployed.
export const SOVEREIGN_FACTORY_DEPLOY_BLOCK = 24_973_294n

// Sentinel "no project ID provided" value. The template's default zero-config
// posture is: no WalletConnect mobile support — `lib/wagmi-config.ts`
// detects this sentinel and ships a connector list that doesn't need a
// project ID (browser-extension wallets, Coinbase Wallet, Safe). Artists
// who want WC mobile QR connections (Rainbow, Trust, MetaMask Mobile, etc)
// set NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID to a real ID from
// cloud.reown.com and the WC connector is added.
//
// We pass *something* here because RainbowKit's getDefaultConfig requires
// a non-empty projectId argument, even when WC isn't in the wallet list.
export const DEFAULT_WALLETCONNECT_PROJECT_ID =
  "0000000000000000000000000000000000000000000000000000000000000000"

function readArtistAddress(): Address {
  const raw = process.env.NEXT_PUBLIC_ARTIST_ADDRESS?.trim()
  if (!raw) {
    throw new Error(
      "NEXT_PUBLIC_ARTIST_ADDRESS is required. Set it in your hosting provider's environment variables (or .env.local for local dev) to your wallet address.",
    )
  }
  if (!isAddress(raw)) {
    throw new Error(
      `NEXT_PUBLIC_ARTIST_ADDRESS is not a valid Ethereum address: ${raw}`,
    )
  }
  return raw as Address
}

function readArtistName(): string | null {
  const raw = process.env.NEXT_PUBLIC_ARTIST_NAME?.trim()
  return raw || null
}

function readLinks(): string[] {
  const raw = process.env.NEXT_PUBLIC_ARTIST_LINKS?.trim()
  if (!raw) return []
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
}

/**
 * Optional Surface this artist wants the page to sell mints for.
 * Unset by default — the template stays auction-only (zero behavior change)
 * until an artist deploys a collection and pastes its address here. Reading
 * `NEXT_PUBLIC_COLLECTION_ADDRESS` literally (never a dynamic
 * `process.env[name]` lookup) is required for Next.js to inline it into the
 * client bundle — see the other NEXT_PUBLIC_* reads in this file.
 */
function readCollectionAddress(): Address | null {
  const raw = process.env.NEXT_PUBLIC_COLLECTION_ADDRESS?.trim()
  if (!raw) return null
  if (!isAddress(raw)) {
    throw new Error(
      `NEXT_PUBLIC_COLLECTION_ADDRESS is not a valid Ethereum address: ${raw}`,
    )
  }
  return raw as Address
}

function readRpcUrls(): string[] | null {
  // Plural takes priority — power users specifying a chain.
  const plural = process.env.NEXT_PUBLIC_RPC_URLS?.trim()
  if (plural) {
    const urls = plural
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
    return urls.length > 0 ? urls : null
  }
  const single = process.env.NEXT_PUBLIC_RPC_URL?.trim()
  if (single) return [single]
  return null
}

// Lazy because Next.js evaluates this file at build time even when
// the dev tries `next dev` without setting env vars first — we want
// the error to fire from the page render with a clean stack, not
// poison module init.
let _config: AppConfig | null = null

export type AppConfig = {
  artistAddress: Address
  /**
   * Display name from `NEXT_PUBLIC_ARTIST_NAME`. May be null when the
   * artist hasn't set one — callers should resolve via
   * `getArtistDisplayName()` (server-only) which falls back to ENS.
   */
  artistName: string | null
  artistAvatarUrl: string | null
  artistBio: string | null
  artistLinks: string[]
  /** User-provided RPC URLs (priority chain). Null when not set — public defaults take over. */
  userRpcUrls: string[] | null
  walletConnectProjectId: string
  factoryAddress: Address
  factoryDeployBlock: bigint
  /**
   * The artist's Surface, if they've deployed one. Null means
   * "no collection configured" — all collection-mint UI (CollectionMintCard,
   * CollectionTokenGrid) is absent from the page in that case, and the
   * template behaves exactly as it did before collection support existed.
   */
  collectionAddress: Address | null
}

/**
 * Absolute site origin for `metadataBase`, so OG/Twitter image URLs resolve
 * to the deployed domain instead of `http://localhost:3000`. Resolution order:
 *   1. NEXT_PUBLIC_SITE_URL  — explicit override (any host)
 *   2. URL / DEPLOY_PRIME_URL — Netlify build-time site URLs
 *   3. VERCEL_PROJECT_PRODUCTION_URL / VERCEL_URL — Vercel
 *   4. localhost fallback (dev)
 *
 * Only consumed server-side (metadata generation). The non-`NEXT_PUBLIC_`
 * platform vars aren't inlined into client bundles, which is fine.
 */
export function getSiteUrl(): string {
  const candidates = [
    process.env.NEXT_PUBLIC_SITE_URL,
    process.env.URL, // Netlify: primary site URL
    process.env.DEPLOY_PRIME_URL, // Netlify: branch / deploy-preview URL
    process.env.VERCEL_PROJECT_PRODUCTION_URL, // Vercel: stable prod domain
    process.env.VERCEL_URL, // Vercel: per-deployment URL
  ]
  for (const raw of candidates) {
    const v = raw?.trim()
    if (v) return v.startsWith("http") ? v : `https://${v}`
  }
  return "http://localhost:3000"
}

export function getConfig(): AppConfig {
  if (_config) return _config
  _config = {
    artistAddress: readArtistAddress(),
    artistName: readArtistName(),
    artistAvatarUrl: process.env.NEXT_PUBLIC_ARTIST_AVATAR_URL?.trim() || null,
    artistBio: process.env.NEXT_PUBLIC_ARTIST_BIO?.trim() || null,
    artistLinks: readLinks(),
    userRpcUrls: readRpcUrls(),
    walletConnectProjectId:
      process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID?.trim() ||
      DEFAULT_WALLETCONNECT_PROJECT_ID,
    factoryAddress: SOVEREIGN_FACTORY_ADDRESS,
    factoryDeployBlock: SOVEREIGN_FACTORY_DEPLOY_BLOCK,
    collectionAddress: readCollectionAddress(),
  }
  return _config
}

export { ZERO as ZERO_ADDRESS }
