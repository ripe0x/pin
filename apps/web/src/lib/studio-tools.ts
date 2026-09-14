/**
 * The single source of truth for the artist studio's tool surface.
 *
 * The studio (`/studio/[address]`) is the owner workspace: every
 * per-artist management surface lives at `/studio/[address]/<tool>`,
 * while the public protocol surfaces stay at top-level routes
 * (`/artist/[address]`, `/catalog/[address]`, `/delist`, `/preserve`,
 * `/sites`, `/editions`). This registry drives the studio sidebar,
 * the dashboard tool cards, and the navbar's "For artists" dropdown,
 * so navigation can't drift from what the studio actually contains.
 *
 * Adding a tool = one entry here + one route folder under
 * `app/studio/[address]/<id>/`. For protocol surfaces that aren't on
 * mainnet yet (PND Editions, Releases), gate the entry with
 * `available`, mirroring the `getAddressOrNull(FACTORY)` pattern
 * `/editions/new` already uses — the tab then ships dark and appears
 * everywhere at once when the factory deploys:
 *
 *   {
 *     id: "editions",
 *     ...
 *     available: () =>
 *       getAddressOrNull(PND_EDITIONS_FACTORY, MAINNET_CHAIN_ID) !== null,
 *   }
 */

import { MAINNET_CHAIN_ID } from "@pin/addresses"
import { surfaceFactory, surfaceFactoryV2 } from "./collection"

/** True when either the v1 or v2 SurfaceFactory resolves for `chainId`
 *  (mainnet by default), or a dev override is set for either. Gates every
 *  tool whose per-collection logic (see the STUDIO_TOOLS entries below)
 *  already routes by the collection's own protocolVersion — the tool works
 *  once ANY Surface factory is live, not only v1. Exported (rather than
 *  private) so tests can exercise all four v1/v2 combinations against an
 *  unconfigured chain id — mainnet itself always resolves v1 today, since
 *  that factory is already deployed. */
export function anySurfaceFactoryLive(chainId: number = MAINNET_CHAIN_ID): boolean {
  return (
    surfaceFactory(chainId) !== null ||
    surfaceFactoryV2(chainId) !== null ||
    process.env.NEXT_PUBLIC_SURFACE_FACTORY !== undefined ||
    process.env.NEXT_PUBLIC_SURFACE_FACTORY_V2 !== undefined
  )
}

export type StudioTool = {
  /** Route segment under /studio/[address]/ */
  id: string
  /** Short nav label (sidebar / tab row). */
  label: string
  /** One-sentence plain-language description for dashboard cards. */
  description: string
  /**
   * Deploy gate. Omit for always-on tools; return false to hide the
   * tool everywhere (nav, dashboard, dropdown) until its contract or
   * backend surface exists. Must be computable on both server and
   * client from build-time constants — never a chain read.
   */
  available?: () => boolean
}

export const STUDIO_TOOLS: StudioTool[] = [
  {
    id: "create",
    label: "Create a collection",
    description: "Deploy a collection contract onchain, configured through a step-by-step form.",
    // The wizard itself picks v2 over v1 per-chain when both resolve (see
    // DeployStep) — the tab only needs to know a deploy is possible at all.
    available: anySurfaceFactoryLive,
  },
  {
    id: "listings",
    label: "Listings",
    description:
      "See and cancel your active listings on Foundation and SuperRare, or move them to your own auction house.",
  },
  {
    id: "auctions",
    label: "Auction house",
    description:
      "Deploy your Sovereign auction house, list works in bulk, and cancel pending auctions.",
  },
  {
    id: "catalog",
    label: "Catalog",
    description:
      "Manage your onchain catalog: the contracts, tokens, and ranges you declare as your work.",
  },
  {
    id: "site",
    label: "Artist site",
    description:
      "Deploy a self-hosted site that reads your auction house straight from the chain.",
  },
  {
    id: "mint-gate",
    label: "Mint gate",
    description:
      "Gate a collection's mint with an allowlist and a per-wallet limit, directly on its canonical minter.",
    // Allowlist + wallet-cap config live on the collection's own canonical
    // FixedPriceMinter clone (v1) or FixedPriceMinterV2 clone (v2) — same
    // setter selectors either way, routed by the collection's own
    // protocolVersion at the panel, not here. Ships dark until a Surface
    // factory (either version) is live on mainnet, or a dev/sepolia override
    // is set (see scripts/dev-collections.sh).
    available: anySurfaceFactoryLive,
  },
  {
    id: "sale",
    label: "Sale settings",
    description:
      "Edit a collection's price, mint window, max mints, payout, and referral share on its canonical minter — reopen a window or raise the cap for the next batch.",
    // Same gate as mint-gate: works against a v1 or v2 collection's
    // canonical minter, routed by protocolVersion at the panel.
    available: anySurfaceFactoryLive,
  },
]

export function studioTools(): StudioTool[] {
  return STUDIO_TOOLS.filter((t) => t.available?.() !== false)
}

export function studioToolHref(address: string, toolId?: string): string {
  const base = `/studio/${address.toLowerCase()}`
  return toolId ? `${base}/${toolId}` : base
}

/**
 * Public, no-wallet-needed artist links for the navbar dropdown and
 * the /studio landing page. These are landing/tool pages that work for
 * anyone (and double as acquisition surfaces) — distinct from the
 * studio routes above, which manage one artist's own instances.
 * Colocated here so the dropdown and the studio stay in one file.
 */
export const PUBLIC_ARTIST_LINKS: { href: string; label: string }[] = [
  { href: "/preserve", label: "Preserve work" },
  { href: "/delist", label: "Leave platforms" },
  { href: "/sites", label: "Run your own site" },
  { href: "/guides", label: "Guides" },
]
