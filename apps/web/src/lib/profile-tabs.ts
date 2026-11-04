// No "server-only" guard: pure tab rules, imported by the page, the client
// tab bar and the plain-Node test runner.

/**
 * Tabs on the unified person profile, `/artist/[address]` (#299). One
 * address can be an artist, a collector, a seller and a Catalog declarer at
 * once, so the page shows a tab per role that has something to show
 * instead of assuming "artist".
 *
 * The URL carries the tab (`?tab=collected`) so a tab is shareable and
 * server-rendered. The default tab is left out of the URL, so existing
 * `/artist/0x…` links keep landing where they always did: the Created
 * gallery, for anyone who has created works.
 */
export const PROFILE_TABS = ["available", "created", "collected", "catalog"] as const
export type ProfileTab = (typeof PROFILE_TABS)[number]

export const PROFILE_TAB_LABELS: Record<ProfileTab, string> = {
  available: "Available",
  created: "Created",
  collected: "Collected",
  catalog: "Catalog",
}

/**
 * Items behind each tab. `null` means the count read failed (cold DB,
 * missing table): the tab stays visible so the page can say the read
 * failed rather than pretend the role doesn't exist.
 */
export type ProfileTabCounts = Record<ProfileTab, number | null>

/** A `?tab=` value as a tab, or null for anything else (missing, unknown, repeated). */
export function parseProfileTab(raw: string | string[] | null | undefined): ProfileTab | null {
  const value = Array.isArray(raw) ? raw[0] : raw
  if (typeof value !== "string") return null
  const normalized = value.trim().toLowerCase()
  return (PROFILE_TABS as readonly string[]).includes(normalized)
    ? (normalized as ProfileTab)
    : null
}

const hasContent = (n: number | null) => n === null || n > 0

/**
 * The tab a bare profile URL opens on. Created wins whenever the address
 * has created works (every existing artist link keeps its gallery); a
 * collector-only address opens on Collected. Available is never the
 * default: it is prominent in the tab order but the profile is a record,
 * not a storefront. An unknown Created count keeps Created, so a failed
 * read shows its error where an artist's visitors expect the gallery
 * instead of moving the page to another tab; other unknown counts never
 * become the default.
 */
export function defaultProfileTab(counts: ProfileTabCounts): ProfileTab {
  if (counts.created === null || counts.created > 0) return "created"
  if ((counts.collected ?? 0) > 0) return "collected"
  if ((counts.catalog ?? 0) > 0) return "catalog"
  if ((counts.available ?? 0) > 0) return "available"
  // Nothing anywhere: Created carries the existing "No works found" copy.
  return "created"
}

/**
 * The tab to render, the tabs to list, and the default tab (whose link is
 * the bare path, see `profileTabHref`).
 *
 * - A valid `?tab=` is honoured even when its count is 0, so a shared link
 *   shows that tab's empty state instead of silently switching.
 * - Otherwise the default above.
 * - Listed tabs: those with content (or an unknown count), plus the active
 *   one, in PROFILE_TABS order. A single tab still lists, so the page
 *   always says which view it is.
 */
export function selectProfileTabs(
  requested: ProfileTab | null,
  counts: ProfileTabCounts,
): { active: ProfileTab; tabs: ProfileTab[]; defaultTab: ProfileTab } {
  const fallback = defaultProfileTab(counts)
  const active = requested ?? fallback
  const tabs = PROFILE_TABS.filter((t) => t === active || hasContent(counts[t]))
  return { active, tabs, defaultTab: fallback }
}

/**
 * The URL for one tab. The default tab is the bare path (one canonical URL
 * per view; old links stay valid); every other tab adds `?tab=`.
 */
export function profileTabHref(address: string, tab: ProfileTab, defaultTab: ProfileTab): string {
  const base = `/artist/${address}`
  return tab === defaultTab ? base : `${base}?tab=${tab}`
}

/** Entries on a Catalog record: declared contracts, tokens and token ranges. */
export function catalogEntryCount(record: {
  contracts: readonly unknown[]
  tokens: readonly unknown[]
  tokenRanges: readonly unknown[]
}): number {
  return record.contracts.length + record.tokens.length + record.tokenRanges.length
}

/** "12", "1.2k", "—" for an unknown count. Tab badges only. */
export function formatTabCount(n: number | null): string {
  if (n === null) return "—"
  if (n < 1000) return String(n)
  if (n < 10_000) return `${(Math.floor(n / 100) / 10).toFixed(1).replace(/\.0$/, "")}k`
  return `${Math.floor(n / 1000)}k`
}
