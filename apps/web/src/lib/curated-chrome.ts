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

/**
 * Chrome for a pathname. Only the curated COLLECTION page is immersive —
 * token pages (/mint/homage/123) keep the standard record chrome.
 */
export function chromeForPath(pathname: string): SiteChrome {
  // Keep these as literal reads so Next can inline them into the client bundle.
  // Reading on invocation also makes this pure helper straightforward to test.
  const homageAddress = (
    process.env.NEXT_PUBLIC_HOMAGE_MINTER_ADDRESS ?? ""
  ).toLowerCase()
  const homageCollection = (
    process.env.NEXT_PUBLIC_HOMAGE_COLLECTION_ADDRESS ?? ""
  ).toLowerCase()
  const m = pathname.match(/^\/mint\/([^/]+)\/?$/)
  const seg = m?.[1]?.toLowerCase()
  if (seg && (seg === "homage" || (homageAddress !== "" && seg === homageAddress))) {
    return IMMERSIVE_CHROME
  }
  // The homage collection's own page and its one-segment sub-pages (redeem and
  // each token detail: /collections/<pooled address>, .../redeem, .../<tokenId>)
  // are skinned and immersive, matching /mint/homage. Deeper routes (e.g. a
  // token's /live doc) fall through to standard chrome. The literal `homage`
  // slug is the pre-deploy landing (/collections/homage), immersive in the same
  // way before the pooled address exists.
  const c = pathname.match(/^\/collections\/([^/]+)(?:\/[^/]+)?\/?$/)?.[1]?.toLowerCase()
  if (c && (c === "homage" || (homageCollection !== "" && c === homageCollection))) {
    return IMMERSIVE_CHROME
  }
  return DEFAULT_CHROME
}
