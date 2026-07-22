/**
 * Mint-run grouping for the activity feed.
 *
 * A successful generative drop lands many near-identical mint events in a
 * short window; ungrouped they fill whole pages and bury everything else.
 * Runs of mints are collapsed by purely mechanical criteria — same
 * contract, same artist, close in time — applied identically to every
 * collection. No ranking, no curation: the feed stays strictly
 * chronological (a group sorts at its newest member) and any non-mint
 * event that lands mid-drop splits the run rather than being reordered
 * around it.
 *
 * Client-safe: pure functions over plain shapes, shared by the server
 * (grouping a raw page before enrichment, which bounds enrichment to
 * representatives instead of every member) and the client (re-merging the
 * boundary where one fetched page's tail continues into the next page's
 * head).
 */

import type {
  EnrichedActivityEvent,
  EnrichedFeedItem,
  EnrichedMintGroup,
  MinterRef,
} from "./v2-activity-types"

/** Runs shorter than this stay individual rows: one or two mints read as
 * individual human acts; three or more within the gap read as a drop. */
export const MINT_GROUP_MIN_RUN = 3

/** Maximum seconds between ADJACENT mints of the same run. A slow drip
 * (gaps above this) stays individual rows even from one collection. */
export const MINT_GROUP_MAX_GAP_SECONDS = 1800

/** The fields grouping decisions read. Satisfied by both the raw
 * `ActivityEvent` and the enriched row shape. */
export type GroupableEvent = {
  id: string
  kind: string
  blockTime: number
  artist: string
  tokenContract: string | null
  quantity: number | null
}

export type FeedRun<E> = {
  type: "run"
  key: string
  /** Members newest-first, same order as the surrounding feed. */
  events: E[]
}

export type FeedSingle<E> = { type: "event"; event: E }

export type FeedItem<E> = FeedSingle<E> | FeedRun<E>

/**
 * Group key for a mint event, or null for everything else. Keyed on
 * (contract, artist): a Surface collection is one contract with one
 * owner, and a shared-contract batch (an artist minting many 1/1s in a
 * sitting) groups per artist rather than mixing artists on the shared
 * contract.
 */
export function mintGroupKey(e: GroupableEvent): string | null {
  if (e.kind !== "mint" || !e.tokenContract) return null
  return `${e.tokenContract.toLowerCase()}:${e.artist.toLowerCase()}`
}

export function tokenCountOf(events: GroupableEvent[]): number {
  return events.reduce((sum, e) => sum + (e.quantity ?? 1), 0)
}

/**
 * Collapse consecutive mint runs in a newest-first event page. Only
 * STRICTLY consecutive events form a run — an interleaved bid or deploy
 * ends it, which keeps the feed honest about ordering. Runs below
 * MINT_GROUP_MIN_RUN events are emitted as singles.
 */
export function groupFeedEvents<E extends GroupableEvent>(
  events: E[],
): FeedItem<E>[] {
  const items: FeedItem<E>[] = []
  let run: E[] = []
  let runKey: string | null = null

  const flush = () => {
    if (runKey !== null && run.length >= MINT_GROUP_MIN_RUN) {
      items.push({ type: "run", key: runKey, events: run })
    } else {
      for (const e of run) items.push({ type: "event", event: e })
    }
    run = []
    runKey = null
  }

  for (const e of events) {
    const key = mintGroupKey(e)
    if (
      key !== null &&
      key === runKey &&
      run.length > 0 &&
      // newest-first: the previous member is newer than this one
      run[run.length - 1].blockTime - e.blockTime <=
        MINT_GROUP_MAX_GAP_SECONDS
    ) {
      run.push(e)
      continue
    }
    flush()
    if (key !== null) {
      runKey = key
      run = [e]
    } else {
      items.push({ type: "event", event: e })
    }
  }
  flush()
  return items
}

// ── Page-boundary merge (client side) ────────────────────────────────────
//
// Server grouping sees one page at a time, so a run crossing a page
// boundary arrives as a tail fragment on one page (possibly below
// MIN_RUN, so emitted as singles) and a head fragment on the next. When
// the client appends a page it re-evaluates the boundary under the same
// rule, over the enriched shapes it holds (groups don't carry their
// member events, so this works on the group summaries + enriched
// singles directly).

/** Cap on the avatar sample a group row shows. */
export const GROUP_MINTER_SAMPLE = 4

function keyOfItem(item: EnrichedFeedItem): string | null {
  return item.type === "group" ? item.key : mintGroupKey(item.event)
}

function newestTime(item: EnrichedFeedItem): number {
  return item.type === "group" ? item.blockTime : item.event.blockTime
}

function oldestTime(item: EnrichedFeedItem): number {
  return item.type === "group" ? item.oldestBlockTime : item.event.blockTime
}

function mintCountOf(item: EnrichedFeedItem): number {
  return item.type === "group" ? item.mintCount : 1
}

function minterRefOf(event: EnrichedActivityEvent): MinterRef | null {
  if (!event.counterparty) return null
  return {
    address: event.counterparty,
    displayName: event.counterpartyDisplayName,
    avatarUrl: event.counterpartyAvatarUrl,
  }
}

function dedupeMinters(refs: (MinterRef | null)[]): MinterRef[] {
  const seen = new Set<string>()
  const out: MinterRef[] = []
  for (const ref of refs) {
    if (!ref) continue
    const addr = ref.address.toLowerCase()
    if (seen.has(addr)) continue
    seen.add(addr)
    out.push(ref)
    if (out.length >= GROUP_MINTER_SAMPLE) break
  }
  return out
}

function addWei(a: bigint | null, b: bigint | null): bigint | null {
  if (a === null) return b
  if (b === null) return a
  return a + b
}

/** Build a group from enriched mint events (newest-first, same key). */
export function buildEnrichedGroup(
  events: EnrichedActivityEvent[],
): EnrichedMintGroup {
  const newest = events[0]
  const oldest = events[events.length - 1]
  const withMedia = events.find((e) => e.mediaUrl !== null)
  return {
    type: "group",
    id: newest.id,
    key: mintGroupKey(newest)!,
    blockTime: newest.blockTime,
    oldestBlockTime: oldest.blockTime,
    artist: newest.artist,
    artistDisplayName: newest.artistDisplayName,
    artistAvatarUrl: newest.artistAvatarUrl,
    tokenContract: newest.tokenContract!,
    collection: newest.collection,
    collectionName: newest.collectionName,
    mintCount: events.length,
    tokenCount: tokenCountOf(events),
    totalWei: events.reduce<bigint | null>(
      (sum, e) => addWei(sum, e.amountWei),
      null,
    ),
    minters: dedupeMinters(events.map(minterRefOf)),
    mediaUrl: withMedia?.mediaUrl ?? null,
    isVideo: withMedia?.isVideo ?? false,
  }
}

/** Merge two same-key fragments; `newer` is the more recent side. */
function mergeFragments(
  newer: EnrichedFeedItem[],
  older: EnrichedFeedItem[],
): EnrichedMintGroup {
  const all = [...newer, ...older]
  const groups = all.filter((i): i is EnrichedMintGroup => i.type === "group")
  const singles = all
    .filter((i): i is { type: "event"; event: EnrichedActivityEvent } => i.type === "event")
    .map((i) => i.event)
  const first = all[0]
  const base: EnrichedMintGroup =
    first.type === "group" ? { ...first } : buildEnrichedGroup([first.event])

  const mediaOf = (i: EnrichedFeedItem) =>
    i.type === "group"
      ? { mediaUrl: i.mediaUrl, isVideo: i.isVideo }
      : { mediaUrl: i.event.mediaUrl, isVideo: i.event.isVideo }
  const withMedia = all.map(mediaOf).find((m) => m.mediaUrl !== null) ?? null

  return {
    ...base,
    blockTime: Math.max(...all.map(newestTime)),
    oldestBlockTime: Math.min(...all.map(oldestTime)),
    mintCount: all.reduce((n, i) => n + mintCountOf(i), 0),
    tokenCount:
      groups.reduce((n, g) => n + g.tokenCount, 0) + tokenCountOf(singles),
    totalWei: all.reduce<bigint | null>(
      (sum, i) =>
        addWei(sum, i.type === "group" ? i.totalWei : i.event.amountWei),
      null,
    ),
    minters: dedupeMinters([
      ...groups.flatMap((g) => g.minters),
      ...singles.map(minterRefOf),
    ]),
    mediaUrl: withMedia?.mediaUrl ?? null,
    isVideo: withMedia?.isVideo ?? false,
  }
}

/**
 * Append `next` (older) to `prev` (newer), re-grouping the boundary. The
 * trailing region of `prev` and leading region of `next` that share one
 * mint key within the gap rule are combined; when the combined event
 * count reaches MIN_RUN they become (or extend) a single group row.
 */
export function appendFeedPage(
  prev: EnrichedFeedItem[],
  next: EnrichedFeedItem[],
): EnrichedFeedItem[] {
  if (prev.length === 0) return next
  if (next.length === 0) return prev

  // Trailing boundary region of `prev`.
  let cut = prev.length
  let boundaryKey: string | null = null
  for (let i = prev.length - 1; i >= 0; i--) {
    const key = keyOfItem(prev[i])
    if (key === null) break
    if (boundaryKey === null) boundaryKey = key
    if (key !== boundaryKey) break
    if (
      i < prev.length - 1 &&
      oldestTime(prev[i]) - newestTime(prev[i + 1]) >
        MINT_GROUP_MAX_GAP_SECONDS
    ) {
      break
    }
    cut = i
  }
  if (boundaryKey === null) return [...prev, ...next]
  const tail = prev.slice(cut)

  // Leading region of `next` under the same key + gap rule.
  let start = 0
  for (const item of next) {
    if (keyOfItem(item) !== boundaryKey) break
    const prevItem = start > 0 ? next[start - 1] : tail[tail.length - 1]
    if (oldestTime(prevItem) - newestTime(item) > MINT_GROUP_MAX_GAP_SECONDS) {
      break
    }
    start++
  }
  if (start === 0) return [...prev, ...next]
  const head = next.slice(0, start)

  const combinedCount =
    tail.reduce((n, i) => n + mintCountOf(i), 0) +
    head.reduce((n, i) => n + mintCountOf(i), 0)

  if (combinedCount < MINT_GROUP_MIN_RUN) return [...prev, ...next]

  return [...prev.slice(0, cut), mergeFragments(tail, head), ...next.slice(start)]
}
