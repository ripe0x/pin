// No "server-only" guard: the view model and paging rules for the profile's
// Collected tab, shared by the server read, the holdings API route, the
// client grid and the plain-Node test runner.
import type { DisplayMedia } from "@pnd/media"
import type { HoldingSource } from "./collector-holdings"

/** Holdings per page on the Collected tab (SSR page and every "Load more"). */
export const COLLECTED_PAGE_SIZE = 24

/**
 * One holding, ready to render. JSON-safe (it is also the holdings API's
 * item shape): `acquiredBlock` is a decimal string.
 */
export type CollectedCard = {
  contract: string
  tokenId: string
  standard: "erc721" | "erc1155"
  /** Decimal string; 1 for ERC-721. */
  balance: string
  /** Block the holding last changed; "0" when only an ownerOf snapshot is known. */
  acquiredBlock: string
  source: HoldingSource
  title: string | null
  /** Derivative / poster first, from Postgres only (lib/display-media.ts). */
  artwork: DisplayMedia
  /** Creator PND attributes the token to, or null when none is indexed. */
  artist: string | null
  /** ENS name when stored, else a truncated address; null without an artist. */
  artistLabel: string | null
}

export type CollectedPage = {
  items: CollectedCard[]
  total: number
  nextCursor: string | null
  /** Holdings are among the works PND indexes, never the whole wallet. */
  coverage: "pnd-indexed-works"
}

/** What the Collected grid holds after zero or more "Load more" clicks. */
export type CollectedState = {
  items: CollectedCard[]
  total: number
  /** Cursor for the next request; null once the list is exhausted. */
  nextCursor: string | null
}

export const collectedKey = (c: Pick<CollectedCard, "contract" | "tokenId">) =>
  `${c.contract.toLowerCase()}:${c.tokenId}`

export function initialCollectedState(page: CollectedPage): CollectedState {
  return mergeCollectedPage({ items: [], total: 0, nextCursor: null }, page, null)
}

/**
 * Append one fetched page.
 *
 * - Items already shown are dropped. Keyset pages never overlap, but a
 *   holding that changes block between requests moves to the front of
 *   the list (collector-holdings.ts); it is already on screen, so it is
 *   not shown twice.
 * - `total` follows the latest page (holdings can change while browsing).
 * - A cursor that comes back unchanged, or a page that adds nothing
 *   while claiming more, ends paging instead of looping on "Load more".
 */
export function mergeCollectedPage(
  state: CollectedState,
  page: CollectedPage,
  requestedCursor: string | null,
): CollectedState {
  const seen = new Set(state.items.map(collectedKey))
  const added: CollectedCard[] = []
  for (const item of page.items) {
    const key = collectedKey(item)
    if (seen.has(key)) continue
    seen.add(key)
    added.push(item)
  }
  const stalled =
    page.nextCursor !== null &&
    (page.nextCursor === requestedCursor || (requestedCursor !== null && added.length === 0))
  const items = state.items.concat(added)
  return {
    items,
    total: Math.max(page.total, items.length),
    nextCursor: stalled ? null : page.nextCursor,
  }
}

/**
 * The holdings API URL for the page after `cursor`. Always `exclude=own`:
 * the tab lists works by others (the SSR page uses the same filter, so the
 * cursor walk stays on one ordering and total).
 */
export function collectedPageUrl(
  address: string,
  cursor: string | null,
  limit = COLLECTED_PAGE_SIZE,
): string {
  const params = new URLSearchParams({ limit: String(limit), exclude: "own" })
  if (cursor) params.set("cursor", cursor)
  return `/api/collector/${address.toLowerCase()}/holdings?${params.toString()}`
}

/** "Showing 24 of 130" style progress line. */
export function collectedProgress(loaded: number, total: number): string {
  if (total <= loaded) return `Showing all ${loaded}`
  return `Showing ${loaded} of ${total}`
}

/** "×3" for an ERC-1155 holding of more than one; null otherwise. */
export function balanceLabel(card: Pick<CollectedCard, "standard" | "balance">): string | null {
  if (card.standard !== "erc1155") return null
  try {
    const n = BigInt(card.balance)
    return n > 1n ? `×${n.toString()}` : null
  } catch {
    return null
  }
}

/**
 * Parse an untrusted holdings API body into a page, or throw. Guards the
 * client against a 200 with an error body or a truncated response.
 */
export function parseCollectedPage(body: unknown): CollectedPage {
  if (!body || typeof body !== "object") throw new Error("Malformed holdings response")
  const b = body as Partial<CollectedPage>
  if (!Array.isArray(b.items) || typeof b.total !== "number") {
    throw new Error("Malformed holdings response")
  }
  return {
    items: b.items as CollectedCard[],
    total: b.total,
    nextCursor: typeof b.nextCursor === "string" && b.nextCursor ? b.nextCursor : null,
    coverage: "pnd-indexed-works",
  }
}
