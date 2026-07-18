/**
 * Pure overlay math for the indexer-first snapshot (Phase 4.2). Kept separate
 * from `mint-onchain.ts` (which is `server-only` + viem) so it's trivially
 * unit-testable and free of the DB/RPC imports. `applyIndexerSnapshotOverlay`
 * in mint-onchain.ts fetches the indexed config/supply, then calls these to
 * merge them over the RPC base snapshot.
 *
 * The contract: indexed values REPLACE the RPC values where present; a null
 * indexed field leaves the RPC value in place (partial sync). This keeps the
 * phase SHAPE (keys/labels) from the descriptor+RPC base intact, so a
 * half-synced config can't drop phases.
 */

import type { PhaseWindow } from "./mint-phases"

/** The subset of a phase descriptor this overlay reads (start/end getter names). */
export type PhaseWindowFns = { startFn: string; endFn?: string }

/** Indexed schedule: getter-name → start timestamp (decimal string) or null. */
export type IndexedSchedule = {
  claimStart: string | null
  allowlistStart: string | null
  publicStart: string | null
}

/**
 * Overlay the indexed schedule onto the RPC-derived phase windows. Each phase's
 * start/end is matched to the indexed value by the getter name the descriptor
 * declares (claimStart / allowlistStart / publicStart). Returns a NEW array;
 * inputs are not mutated. `baseWindows` and `phaseFns` are index-aligned (both
 * come from the descriptor's `phases`).
 */
export function overlayPhaseWindows(
  baseWindows: PhaseWindow[],
  phaseFns: (PhaseWindowFns | undefined)[],
  schedule: IndexedSchedule,
): PhaseWindow[] {
  const startByFn: Record<string, string | null> = {
    claimStart: schedule.claimStart,
    allowlistStart: schedule.allowlistStart,
    publicStart: schedule.publicStart,
  }
  return baseWindows.map((w, i) => {
    const p = phaseFns[i]
    const idxStart = p ? startByFn[p.startFn] : undefined
    const idxEnd = p?.endFn ? startByFn[p.endFn] : undefined
    return {
      ...w,
      start: idxStart != null ? idxStart : w.start,
      end: idxEnd != null ? idxEnd : w.end,
    }
  })
}

/**
 * The overall "mint opens" timestamp for consumers that don't understand
 * phases: the earliest scheduled (nonzero) phase start. Falls back to
 * `fallback` when nothing is scheduled. Decimal string.
 */
export function overallStartFromWindows(windows: PhaseWindow[], fallback: string): string {
  const starts = windows.map((p) => BigInt(p.start)).filter((s) => s > 0n)
  return starts.length > 0 ? starts.reduce((a, b) => (b < a ? b : a)).toString() : fallback
}
