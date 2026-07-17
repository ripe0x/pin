/**
 * Site-chrome variants for curated project pages.
 *
 * Some curated collections own their whole page layout (the `customLayout`
 * descriptor field in mint-collections.ts) and need the site shell to step
 * back: a transparent navbar over the page's own background, no site footer
 * (the page ships its own), and no pt-16 offset (the page pads itself under
 * the fixed navbar).
 *
 * This module is consumed by client chrome components (Navbar,
 * SiteChromeShell) via usePathname(), so it must stay LEAN: no ABI imports,
 * no descriptor registry — only literal NEXT_PUBLIC_* reads (dynamic
 * process.env[name] lookups are not inlined into the client bundle; see the
 * note in mint-collections.ts).
 *
 * SYNC CONTRACT: a descriptor that sets `customLayout` (mint-collections.ts)
 * MUST have its slug + address mapped to immersive chrome here — the test
 * runner can't import the registry (extensionless imports), so this is a
 * documented invariant, exercised by curated-chrome.test.ts per collection.
 *
 * Homage's descriptor `address` resolves to `NEXT_PUBLIC_HOMAGE_MINTER_ADDRESS`
 * (the sovereign-rebuild's mint engine, not the separate pooled collection —
 * see mint-modules/homage.ts) since `/mint/[contract]` resolves by slug OR
 * the descriptor's primary `address`.
 */

export type SiteChrome = {
  /** "overlay-dark": transparent bg, no border, `dark`-scoped tokens. */
  navbar: "solid" | "overlay-dark"
  /** Render the site footer? Immersive pages ship their own. */
  footer: boolean
  /** Offset <main> below the fixed 64px navbar? Immersive pages overlay it. */
  padTop: boolean
}

const DEFAULT_CHROME: SiteChrome = { navbar: "solid", footer: true, padTop: true }
const IMMERSIVE_CHROME: SiteChrome = { navbar: "overlay-dark", footer: false, padTop: false }

// Literal env reads (see module note). Lowercased once for path comparison.
const HOMAGE_ADDRESS = (process.env.NEXT_PUBLIC_HOMAGE_MINTER_ADDRESS ?? "").toLowerCase()
// The pooled collection address — the homage /collections/<addr> page renders in
// the terminal skin and owns its chrome the same way /mint/homage does.
const HOMAGE_COLLECTION = (process.env.NEXT_PUBLIC_HOMAGE_COLLECTION_ADDRESS ?? "").toLowerCase()

/**
 * Chrome for a pathname. Only the curated COLLECTION page is immersive —
 * token pages (/mint/homage/123) keep the standard record chrome.
 */
export function chromeForPath(pathname: string): SiteChrome {
  const m = pathname.match(/^\/mint\/([^/]+)\/?$/)
  const seg = m?.[1]?.toLowerCase()
  if (seg && (seg === "homage" || (HOMAGE_ADDRESS !== "" && seg === HOMAGE_ADDRESS))) {
    return IMMERSIVE_CHROME
  }
  // The homage collection's own page and its one-segment sub-pages (redeem and
  // each token detail: /collections/<pooled address>, .../redeem, .../<tokenId>)
  // are skinned and immersive, matching /mint/homage. Deeper routes (e.g. a
  // token's /live doc) fall through to standard chrome.
  const c = pathname.match(/^\/collections\/([^/]+)(?:\/[^/]+)?\/?$/)?.[1]?.toLowerCase()
  if (c && HOMAGE_COLLECTION !== "" && c === HOMAGE_COLLECTION) {
    return IMMERSIVE_CHROME
  }
  return DEFAULT_CHROME
}
