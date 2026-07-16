/**
 * Post-mint reveal: pull the drawn tokenId out of the mint receipt so
 * MintPanel can link straight to `/mint/[contract]/[tokenId]`.
 *
 * Two sources, declared per collection via `reveal` on the descriptor:
 *
 *   - `{ kind: "transfer-log" }` — the ERC-721 default. Scan the receipt for
 *     a `Transfer(address,address,uint256)` emitted by the collection with
 *     `from == address(0)` (a mint) and take the indexed tokenId. Needs no
 *     ABI knowledge beyond the standard.
 *   - `{ kind: "event"; abiEvent }` — collections that announce the draw with
 *     their own event (e.g. Homage's `Minted`/`Claimed` carrying an indexed
 *     punkId). The named event is decoded against the collection ABI and the
 *     tokenId-like argument extracted.
 *
 * Pure log parsing over the already-fetched receipt — zero extra RPC. Kept
 * free of `@pin/*` / `@/` imports (viem only) so the unit tests run under
 * `node --experimental-strip-types --test` without path-alias resolution.
 */

import { type Abi, parseEventLogs } from "viem"

// ── descriptor shape ────────────────────────────────────────────────────────

export type RevealSource =
  | { kind: "transfer-log" } // ERC-721 Transfer(from=0) from the collection
  | { kind: "event"; abiEvent: string } // named event on the collection ABI

/** The receipt-log subset the extractor needs (viem's `Log` satisfies this). */
export type RevealLog = {
  address: string
  topics: readonly `0x${string}`[]
  data: `0x${string}`
}

// keccak256("Transfer(address,address,uint256)") — the shared ERC-20/721
// Transfer topic. ERC-721 indexes all three params (4 topics total), ERC-20
// only two (3 topics), so topic count disambiguates the standards.
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"

// ── extraction ──────────────────────────────────────────────────────────────

/**
 * Extract the minted tokenId from receipt logs, or null when no matching log
 * exists (wrong event name, non-mint tx, malformed logs — the caller falls
 * back to the plain success banner). For multi-token receipts (quantity
 * mints) the FIRST matching log wins: one reveal link, pointing at the first
 * token drawn.
 */
export function extractRevealTokenId(opts: {
  reveal: RevealSource
  logs: readonly RevealLog[]
  /** The collection contract — logs from other contracts are ignored. */
  collection: string
  abi: Abi
  /**
   * When given, transfer-log PREFERS mints to this address but falls back to
   * the first collection mint in the receipt. The receipt is the caller's own
   * tx, so any Transfer(from=0) the collection emitted IS a token this tx
   * minted — just not necessarily to the payer (Homage's claimFor mints to
   * the delegate's vault, claimTo to the punk's holder). A strict to==minter
   * filter would silently drop the reveal for those routed mints.
   */
  minter?: string
}): bigint | null {
  const { reveal, logs, collection, abi, minter } = opts
  const collectionLc = collection.toLowerCase()

  if (reveal.kind === "transfer-log") {
    let fallback: bigint | null = null
    for (const log of logs) {
      if (log.address.toLowerCase() !== collectionLc) continue
      if (log.topics.length !== 4) continue // ERC-721 shape (all params indexed)
      if (log.topics[0] !== TRANSFER_TOPIC) continue
      if (BigInt(log.topics[1]) !== 0n) continue // from == address(0): a mint
      if (!minter || BigInt(log.topics[2]) === BigInt(minter)) return BigInt(log.topics[3])
      if (fallback === null) fallback = BigInt(log.topics[3])
    }
    return fallback
  }

  // kind === "event": decode the named event against the collection ABI.
  // `strict: false` skips logs that don't match instead of throwing, so a
  // receipt full of unrelated logs (swaps, wraps) degrades to null cleanly.
  let parsed: ReturnType<typeof parseEventLogs>
  try {
    parsed = parseEventLogs({
      abi,
      eventName: reveal.abiEvent,
      logs: logs as never,
      strict: false,
    })
  } catch {
    return null // event name absent from the ABI
  }
  for (const log of parsed) {
    if (log.address.toLowerCase() !== collectionLc) continue
    const id = pickTokenIdArg((log as { args?: unknown }).args)
    if (id !== null) return id
  }
  return null
}

/**
 * Pick the tokenId-like argument from decoded event args. Named args are
 * preferred by name ("tokenId" | "punkId" | "id", case-insensitive, then any
 * `*Id`-suffixed uint); positional (unnamed-param) args fall back to the
 * first bigint. Returns null when nothing bigint-shaped exists.
 */
function pickTokenIdArg(args: unknown): bigint | null {
  if (args === null || typeof args !== "object") return null

  if (Array.isArray(args)) {
    const first = args.find((v): v is bigint => typeof v === "bigint")
    return first ?? null
  }

  const rec = args as Record<string, unknown>
  const names = Object.keys(rec)
  const exact = names.find((n) => /^(tokenid|punkid|id)$/i.test(n))
  if (exact && typeof rec[exact] === "bigint") return rec[exact] as bigint
  const suffixed = names.find((n) => /id$/i.test(n) && typeof rec[n] === "bigint")
  if (suffixed) return rec[suffixed] as bigint
  const firstBig = names.find((n) => typeof rec[n] === "bigint")
  return firstBig ? (rec[firstBig] as bigint) : null
}
