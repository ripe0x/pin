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

// Placeholder WalletConnect project ID. Used as a fallback so the wagmi
// config can construct without env var setup, but we deliberately suppress
// the WalletConnect connector when this default is in play (Reown will
// reject this ID with HTTP 403, which would otherwise break the Connect
// button entirely). When the artist sets their own real project ID via
// NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID, the WC mobile connector becomes
// available; until then, only browser-extension wallets and Coinbase
// Wallet appear in the picker. See `lib/wagmi-config.ts`.
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
  }
  return _config
}

export { ZERO as ZERO_ADDRESS }
