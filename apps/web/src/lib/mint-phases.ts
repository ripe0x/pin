/**
 * Phase model + resolution for phased mints (claim → allowlist → public).
 *
 * A phased collection declares an ordered `MintPhase[]` on its descriptor;
 * when present it supersedes the descriptor's single `window`. Window
 * semantics (matching contracts whose schedule is a set of start timestamps,
 * e.g. [claimStart, allowlistStart), [allowlistStart, publicStart),
 * [publicStart, ∞)):
 *
 *   - each phase's `startFn` is a uint256 getter returning unix seconds;
 *     **0 means unscheduled/closed** — the phase never activates,
 *   - a phase ends where the next begins: `endFn` is (by convention) the
 *     next phase's `startFn`. `endFn` omitted, or the getter returning 0,
 *     means the phase is open-ended once started (the last phase, or a
 *     schedule whose next phase isn't set yet),
 *   - start is inclusive, end is exclusive: at `now == end` the next phase
 *     has already begun.
 *
 * `resolvePhaseState` is a pure function over the snapshot's window values
 * and a clock — deliberately free of viem/react imports so it's trivially
 * unit-testable and shared verbatim between the server page (render-time
 * clock) and MintPanel (the RPC-frugal `useChainNowSec` tick). The window
 * values themselves come from ONE multicall in `getMintSnapshot()`; resolving
 * here costs zero extra RPC.
 */

// ── descriptor shape ────────────────────────────────────────────────────────

export type MintPhase = {
  /** Stable identifier, e.g. "claim" | "allowlist" | "public". */
  key: string
  /** UI label, e.g. "Claim", "Allowlist", "Public". */
  label: string
  /**
   * Window getters on the collection contract (unix-seconds uint256 views).
   * 0 from `startFn` = unscheduled/closed. `endFn` is conventionally the
   * NEXT phase's startFn; omit it on the last (open-ended) phase.
   */
  window: { startFn: string; endFn?: string }
  /** The write for this phase, e.g. "claim" | "allowlistMint" | "mint". */
  mintFn: string
  /** Key into the eligibility-provider registry (mint-registries.ts). */
  eligibility?: string
  /** Key into the args-builder registry (mint-registries.ts). */
  argsBuilder?: string
  /**
   * Key into the quote-provider registry — a per-phase override of the
   * collection-level `price` (which may itself be `{ kind: "quote" }`).
   */
  priceQuote?: string
  /**
   * Key into the phase-selector component registry (mint-slots.tsx) — the
   * UI that produces the `selection` an args builder consumes (e.g. a punk
   * picker). Omit for no-selection phases.
   */
  selector?: string
  /** Phase-specific action noun for copy, e.g. "claim your punk's homage". */
  noun?: string
}

// ── snapshot → resolution ───────────────────────────────────────────────────

/**
 * One phase's resolved window bounds, as carried on `MintSnapshot`. Decimal
 * strings (bigint-safe across the RSC boundary), same convention as the rest
 * of the snapshot. "0" = unscheduled (start) / open-ended (end).
 */
export type PhaseWindow = {
  key: string
  label: string
  start: string
  end: string
}

export type PhaseState = {
  /** Index into the descriptor's `phases` array; -1 when nothing is live. */
  activeIndex: number
  activeKey: string | null
  /** The next phase to open (earliest scheduled future start); -1/null/0n when none. */
  nextIndex: number
  nextKey: string | null
  nextStart: bigint
  /** True if any phase has a nonzero (scheduled) start. */
  anyScheduled: boolean
  /** True when every scheduled window has closed and nothing is upcoming. */
  allEnded: boolean
}

/**
 * Resolve which phase is live and what opens next, at `nowSec`.
 *
 * Callers must gate on a known clock (`nowSec > 0`) before drawing end-state
 * conclusions — same contract as `useChainNowSec`, which returns 0 until its
 * first block read resolves. With `nowSec == 0` every scheduled phase looks
 * upcoming, which renders as a harmless "not open yet" placeholder frame.
 *
 * If windows overlap (a misconfigured schedule), the later phase wins — later
 * phases supersede earlier ones, matching the [start_i, start_{i+1}) intent.
 */
export function resolvePhaseState(windows: PhaseWindow[], nowSec: number): PhaseState {
  const now = BigInt(Math.max(0, nowSec))

  let activeIndex = -1
  let anyScheduled = false
  for (let i = 0; i < windows.length; i++) {
    const start = BigInt(windows[i].start)
    if (start === 0n) continue // unscheduled — never active
    anyScheduled = true
    const end = BigInt(windows[i].end)
    if (now >= start && (end === 0n || now < end)) activeIndex = i
  }

  let nextIndex = -1
  let nextStart = 0n
  for (let i = 0; i < windows.length; i++) {
    const start = BigInt(windows[i].start)
    if (start === 0n || start <= now) continue
    if (nextStart === 0n || start < nextStart) {
      nextStart = start
      nextIndex = i
    }
  }

  return {
    activeIndex,
    activeKey: activeIndex >= 0 ? windows[activeIndex].key : null,
    nextIndex,
    nextKey: nextIndex >= 0 ? windows[nextIndex].key : null,
    nextStart,
    anyScheduled,
    allEnded: anyScheduled && activeIndex === -1 && nextIndex === -1,
  }
}
