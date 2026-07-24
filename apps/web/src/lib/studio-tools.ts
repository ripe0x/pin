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
import { surfaceFactory } from "./collection"

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
    available: () => surfaceFactory(MAINNET_CHAIN_ID) !== null,
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
    // FixedPriceMinter clone (thin-token rearchitecture — there's no
    // separate GateHook to deploy anymore), so this tool ships dark until
    // Surface itself is live on mainnet, same gate as the collections
    // surfaces; live in dev via the harness's NEXT_PUBLIC_SURFACE_FACTORY
    // override (see scripts/dev-collections.sh).
    available: () =>
      surfaceFactory(MAINNET_CHAIN_ID) !== null || process.env.NEXT_PUBLIC_SURFACE_FACTORY !== undefined,
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
