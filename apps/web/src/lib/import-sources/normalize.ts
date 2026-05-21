import type { Address } from "viem"
import { MAINNET_CHAIN_ID } from "@pin/addresses"
import type {
  CatalogOp,
  NormalizedPlan,
  RawWork,
  SkippedWork,
} from "./types.ts"

/**
 * The Catalog snapshot shape we need for dedup. Matches the existing
 * `Catalog` type returned by `apps/web/src/lib/catalog.ts:getCatalog`
 * but we keep our own minimal copy to avoid pulling in a `server-only`
 * module from a pure data function — these helpers run in both server
 * and test contexts.
 */
export type CatalogSnapshot = {
  contracts: Address[]
  tokens: Array<{ contractAddress: Address; tokenId: string }>
  tokenRanges: Array<{
    contractAddress: Address
    startTokenId: string
    endTokenId: string
  }>
}

/**
 * Build the list of Catalog write ops from a raw source dump, after:
 *  - filtering out non-mainnet works (Catalog only deployed on chainId 1),
 *  - dropping unparseable entries (no contract / no tokenId),
 *  - deduping against the on-chain Catalog snapshot,
 *  - trimming ranges that partially overlap existing entries.
 *
 * Output is grouped by contract (lowercased) so the UI can render
 * collapsible per-contract sections without an extra pass.
 */
export function normalize(
  works: RawWork[],
  existing: CatalogSnapshot,
  offChain: SkippedWork[] = [],
): NormalizedPlan {
  const ops: CatalogOp[] = []
  const alreadyIndexed: RawWork[] = []
  const nonMainnet: RawWork[] = []
  const unparseable: RawWork[] = []

  const dedup = buildDedupIndex(existing)

  // Step 1: filter + explode into per-(contract, token) intents.
  // Each RawWork can produce 1 single, 1 range, or N singles (token list).
  type Intent =
    | { kind: "single"; contract: Address; tokenId: bigint; work: RawWork }
    | {
        kind: "range"
        contract: Address
        start: bigint
        end: bigint
        work: RawWork
      }
  const intents: Intent[] = []

  for (const w of works) {
    if (w.chainId !== MAINNET_CHAIN_ID) {
      nonMainnet.push(w)
      continue
    }
    if (!w.contract) {
      unparseable.push(w)
      continue
    }
    const contract = w.contract.toLowerCase() as Address

    if (
      w.tokenIdStart !== undefined &&
      w.tokenIdEnd !== undefined &&
      w.tokenIdEnd >= w.tokenIdStart
    ) {
      if (w.tokenIdStart === w.tokenIdEnd) {
        intents.push({
          kind: "single",
          contract,
          tokenId: w.tokenIdStart,
          work: w,
        })
      } else {
        intents.push({
          kind: "range",
          contract,
          start: w.tokenIdStart,
          end: w.tokenIdEnd,
          work: w,
        })
      }
      continue
    }

    if (w.tokenIds && w.tokenIds.length > 0) {
      for (const tid of w.tokenIds) {
        intents.push({ kind: "single", contract, tokenId: tid, work: w })
      }
      continue
    }

    if (w.tokenId !== undefined) {
      intents.push({
        kind: "single",
        contract,
        tokenId: w.tokenId,
        work: w,
      })
      continue
    }

    unparseable.push(w)
  }

  // Step 2: dedup + trim against existing Catalog. Whole-contract
  // coverage trumps everything; partial-overlap ranges get trimmed
  // into the remaining uncovered slice(s).
  for (const intent of intents) {
    if (dedup.contracts.has(intent.contract)) {
      alreadyIndexed.push(intent.work)
      continue
    }

    if (intent.kind === "single") {
      if (dedup.isTokenCovered(intent.contract, intent.tokenId)) {
        alreadyIndexed.push(intent.work)
        continue
      }
      ops.push({
        kind: "addToken",
        contract: intent.contract,
        tokenId: intent.tokenId,
        works: [intent.work],
      })
    } else {
      const uncovered = dedup.subtractFromRange(
        intent.contract,
        intent.start,
        intent.end,
      )
      if (uncovered.length === 0) {
        alreadyIndexed.push(intent.work)
        continue
      }
      for (const [s, e] of uncovered) {
        if (s === e) {
          ops.push({
            kind: "addToken",
            contract: intent.contract,
            tokenId: s,
            works: [intent.work],
          })
        } else {
          ops.push({
            kind: "addTokenRange",
            contract: intent.contract,
            start: s,
            end: e,
            works: [intent.work],
          })
        }
      }
    }
  }

  // Step 2.5: collapse intra-list duplicates. Source feeds (notably
  // Brinkman's) sometimes list the same on-chain token twice (e.g. when
  // a work has multiple slugs pointing at it). Merge those into one op
  // and concat the `works` references so the UI shows all source rows
  // that contributed.
  // `normalize` itself only ever produces token/range ops — `addContract`
  // is a planner-side consolidation the UI emits when the artist opts
  // in. The two helpers below narrow to those variants so the merge
  // key + sort comparator don't have to deal with the wider union.
  function tokenOrRangeKey(
    op: Extract<CatalogOp, { kind: "addToken" | "addTokenRange" }>,
  ): string {
    return op.kind === "addToken"
      ? `t:${op.contract}:${op.tokenId.toString()}`
      : `r:${op.contract}:${op.start.toString()}-${op.end.toString()}`
  }
  function rangeStart(
    op: Extract<CatalogOp, { kind: "addToken" | "addTokenRange" }>,
  ): bigint {
    return op.kind === "addToken" ? op.tokenId : op.start
  }

  const opIndex = new Map<string, CatalogOp>()
  const merged: CatalogOp[] = []
  for (const op of ops) {
    if (op.kind === "addContract") continue // unreachable here, satisfies TS
    const key = tokenOrRangeKey(op)
    const prev = opIndex.get(key)
    if (prev) {
      prev.works.push(...op.works)
    } else {
      opIndex.set(key, op)
      merged.push(op)
    }
  }
  ops.length = 0
  ops.push(...merged)

  // Step 3: stable sort — contract groups together, ranges before
  // singles within each contract. Contracts themselves are kept in
  // INPUT order (the first time each contract appeared in the
  // adapter's output dictates its position), so adapters can control
  // the contract ordering via their SQL/source order. The pnd-indexed
  // adapter sorts by recency (newest-deployed first); we don't want
  // an alphabetical re-sort here to undo that.
  const contractFirstSeen = new Map<Address, number>()
  let nextIdx = 0
  for (const op of ops) {
    if (!contractFirstSeen.has(op.contract)) {
      contractFirstSeen.set(op.contract, nextIdx++)
    }
  }
  ops.sort((a, b) => {
    if (a.contract !== b.contract) {
      return (
        (contractFirstSeen.get(a.contract) ?? 0) -
        (contractFirstSeen.get(b.contract) ?? 0)
      )
    }
    if (a.kind !== b.kind) return a.kind === "addTokenRange" ? -1 : 1
    if (a.kind === "addContract" || b.kind === "addContract") return 0
    const aId = rangeStart(a)
    const bId = rangeStart(b)
    return aId < bId ? -1 : aId > bId ? 1 : 0
  })

  return { ops, alreadyIndexed, nonMainnet, unparseable, offChain }
}

/**
 * Pre-indexed view of the on-chain snapshot. Building this once is O(N)
 * but lets the per-intent dedup loop above stay O(1) per single and
 * O(R) per range (R = number of existing ranges on that contract,
 * usually 0–2).
 */
function buildDedupIndex(snap: CatalogSnapshot) {
  const contracts = new Set<Address>(
    snap.contracts.map((c) => c.toLowerCase() as Address),
  )
  const tokensByContract = new Map<Address, Set<string>>()
  for (const t of snap.tokens) {
    const c = t.contractAddress.toLowerCase() as Address
    if (!tokensByContract.has(c)) tokensByContract.set(c, new Set())
    tokensByContract.get(c)!.add(t.tokenId)
  }
  const rangesByContract = new Map<
    Address,
    Array<{ start: bigint; end: bigint }>
  >()
  for (const r of snap.tokenRanges) {
    const c = r.contractAddress.toLowerCase() as Address
    if (!rangesByContract.has(c)) rangesByContract.set(c, [])
    rangesByContract.get(c)!.push({
      start: BigInt(r.startTokenId),
      end: BigInt(r.endTokenId),
    })
  }

  function isTokenCovered(contract: Address, tokenId: bigint): boolean {
    const ts = tokensByContract.get(contract)
    if (ts && ts.has(tokenId.toString())) return true
    const rs = rangesByContract.get(contract)
    if (!rs) return false
    return rs.some((r) => tokenId >= r.start && tokenId <= r.end)
  }

  /**
   * Subtract the union of (existing ranges ∪ existing singles) on
   * `contract` from the closed interval [start, end]. Returns the
   * remaining uncovered closed intervals, sorted ascending. Empty array
   * = fully covered.
   */
  function subtractFromRange(
    contract: Address,
    start: bigint,
    end: bigint,
  ): Array<[bigint, bigint]> {
    const covers: Array<{ s: bigint; e: bigint }> = []
    const rs = rangesByContract.get(contract)
    if (rs) for (const r of rs) covers.push({ s: r.start, e: r.end })
    const ts = tokensByContract.get(contract)
    if (ts) {
      for (const tid of ts) {
        const n = BigInt(tid)
        covers.push({ s: n, e: n })
      }
    }
    // Sort + merge overlapping covers so the subtraction sweep below
    // sees disjoint intervals.
    covers.sort((a, b) => (a.s < b.s ? -1 : a.s > b.s ? 1 : 0))
    const merged: Array<{ s: bigint; e: bigint }> = []
    for (const c of covers) {
      const last = merged[merged.length - 1]
      if (last && c.s <= last.e + 1n) {
        if (c.e > last.e) last.e = c.e
      } else {
        merged.push({ s: c.s, e: c.e })
      }
    }
    // Sweep [start, end], emitting gaps.
    const out: Array<[bigint, bigint]> = []
    let cursor = start
    for (const c of merged) {
      if (c.e < cursor) continue
      if (c.s > end) break
      if (c.s > cursor) out.push([cursor, c.s - 1n])
      cursor = c.e + 1n
      if (cursor > end) break
    }
    if (cursor <= end) out.push([cursor, end])
    return out
  }

  return { contracts, isTokenCovered, subtractFromRange }
}

/**
 * Chunk size for splitting a long op list into multiple multicall txs.
 * 50 keeps each tx well under any practical block-gas concern while
 * still collapsing a 200+ op import into ~5 signatures.
 */
export const OPS_PER_TX = 50

export function chunkOps(ops: CatalogOp[]): CatalogOp[][] {
  const out: CatalogOp[][] = []
  for (let i = 0; i < ops.length; i += OPS_PER_TX) {
    out.push(ops.slice(i, i + OPS_PER_TX))
  }
  return out
}
