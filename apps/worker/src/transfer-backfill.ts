/**
 * Transfer-history backfill for tokens discovered after scan-token-
 * transfers' cursor already passed their blocks (audit H2, #295).
 *
 * The forward scan drops every Transfer log whose token isn't in
 * `artist_tokens` yet, and its per-contract cursor runs independently of
 * (and usually ahead of) mint discovery. A token discovered later (mint
 * scanner still backfilling, Manifold fast backfill, scan-pnd-auction-
 * tokens, a newly known artist on an already-scanned contract) used to
 * keep a permanent hole in its history.
 *
 * Migration 030 adds `transfer_backfill_queue` and an AFTER INSERT
 * trigger on `artist_tokens` that enqueues every newly inserted token
 * (contract, token_id, next_block = mint_block). The trigger catches all
 * insert paths, including the pure-SQL seed copies, with no per-writer
 * wiring. scan-token-transfers drains the queue after its forward scan
 * (same single-flight task, so the forward cursor is stable while the
 * queue is planned), bounded per tick:
 *
 *   - No forward cursor for the contract: the forward scan hasn't
 *     started it, and its first window starts at MIN(mint_block), which
 *     already includes the token. Nothing to backfill; drop the row.
 *   - `next_block` above the forward cursor: the forward scan will reach
 *     it with the token already known. Drop the row.
 *   - Otherwise: scan [min next_block over the contract's queued rows,
 *     forward cursor] for that contract in one scan-range walk (one
 *     range per CONTRACT, not per token, so a contract discovered with
 *     1,000 tokens costs one walk). Writes are the forward scan's
 *     idempotent inserts. Progress is saved in `next_block`; rows are
 *     deleted when the walk reaches the cursor.
 *
 * A mint block of 0 (the Alchemy fast backfill writes 0 when the API
 * omits it) is floored at the contract's lowest known positive mint
 * block rather than walking from genesis.
 *
 * Pure module, unit-tested.
 */

export type BackfillQueueRow = {
  contract: string
  tokenId: string
  nextBlock: bigint
}

export type BackfillWork = {
  contract: string
  from: bigint
  to: bigint
  tokenIds: string[]
}

export type BackfillPlan = {
  work: BackfillWork[]
  /** Rows that need no scan; delete them. */
  done: Array<{ contract: string; tokenIds: string[] }>
}

export function planBackfill(
  rows: BackfillQueueRow[],
  ctx: {
    /** Forward scan-token-transfers cursor per contract (absent = none yet). */
    cursorByContract: Map<string, bigint>
    /** Lowest known positive mint block per contract, for rows at 0. */
    floorByContract: Map<string, bigint>
  },
): BackfillPlan {
  const work = new Map<string, BackfillWork>()
  const done = new Map<string, string[]>()
  const markDone = (contract: string, tokenId: string) => {
    const list = done.get(contract) ?? []
    list.push(tokenId)
    done.set(contract, list)
  }

  for (const r of rows) {
    const cursor = ctx.cursorByContract.get(r.contract)
    if (cursor === undefined) {
      markDone(r.contract, r.tokenId)
      continue
    }
    let from = r.nextBlock
    if (from <= 0n) {
      const floor = ctx.floorByContract.get(r.contract)
      if (floor === undefined) {
        markDone(r.contract, r.tokenId)
        continue
      }
      from = floor
    }
    if (from > cursor) {
      markDone(r.contract, r.tokenId)
      continue
    }
    const w = work.get(r.contract)
    if (w) {
      if (from < w.from) w.from = from
      w.tokenIds.push(r.tokenId)
    } else {
      work.set(r.contract, { contract: r.contract, from, to: cursor, tokenIds: [r.tokenId] })
    }
  }

  const byContract = (a: { contract: string }, b: { contract: string }) =>
    a.contract.localeCompare(b.contract)
  return {
    work: Array.from(work.values()).sort(byContract),
    done: Array.from(done.entries())
      .map(([contract, tokenIds]) => ({ contract, tokenIds }))
      .sort(byContract),
  }
}
