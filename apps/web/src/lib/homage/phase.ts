// Homage mint schedule → current window + next transition. Mirrors HomageMinter's
// gating, layered rather than a strict partition:
//
//   reservation [schedule-set, claimStart)    punk owners withhold their punk id
//                                              from the random draw (see reserve*)
//   claim       [claimStart, ∞)               punk owners mint their OWN tokenId;
//                                              open-ended, an overlay capability
//                                              that stays live through allowlist
//                                              and public rather than closing at
//                                              allowlistStart
//   allowlist   [allowlistStart, publicStart) allowlisted addrs, random draw
//   public      [publicStart, ∞)              anyone, random draw
//
// `currentPhase` still names the single EXCLUSIVE random-draw window a wallet is in
// (closed / allowlist / public) for the instrument that drives the draw — claim is
// deliberately absent from that partition now. When claimStart == allowlistStart
// (a merged claim+allowlist window), `currentPhase` naturally reports "allowlist"
// at that boundary, which is correct: the draw instrument is in its allowlist
// window, and `claimOpen` independently reports the claim overlay is also live.
// Use `claimOpen` / `reservationOpenAt` below for those overlay capabilities
// instead of reading `currentPhase() === "claim"` (that variant no longer exists
// on the partition, though the "claim" Phase value is kept for the fork-only dev
// toggle, which still targets a claim-shaped window for previewing).
//
// All-zero (unscheduled) or before the first boundary = closed. A window whose two
// bounds are equal is collapsed (skipped).

export type Schedule = {
  claimStart: number // unix seconds (0 = unset/closed)
  allowlistStart: number
  publicStart: number
}

export type Phase = "closed" | "claim" | "allowlist" | "public"

export const PHASE_LABEL: Record<Phase, string> = {
  closed: "Minting not open",
  claim: "Punk owner mint",
  allowlist: "Allowlist mint",
  public: "Public mint",
}

/** The active window at `nowSec`, matching the contract's `_inXPhase()` checks. */
export function currentPhase(s: Schedule, nowSec: number): Phase {
  if (s.publicStart !== 0 && nowSec >= s.publicStart) return "public"
  if (s.allowlistStart !== 0 && nowSec >= s.allowlistStart && nowSec < s.publicStart) return "allowlist"
  if (s.claimStart !== 0 && nowSec >= s.claimStart && nowSec < s.allowlistStart) return "claim"
  return "closed"
}

/**
 * The next window boundary after `nowSec` (what a countdown ticks toward), or null if
 * there's nothing ahead (already public / open-ended, or fully unscheduled). Collapsed
 * windows (equal bounds) are skipped, so the countdown always targets a real opening.
 */
/** How each window is named in copy. The claim window mints at the flat fee, so it is
 *  never called just "claim", which would read as free. */
export const WINDOW_LABEL: Record<Phase, string> = {
  closed: "mint",
  claim: "punk mint claim",
  allowlist: "allowlist",
  public: "public mint",
}

export function nextTransition(s: Schedule, nowSec: number): {to: Phase; at: number} | null {
  const bounds: {to: Phase; at: number}[] = []
  if (s.claimStart !== 0 && s.claimStart < s.allowlistStart) bounds.push({to: "claim", at: s.claimStart})
  if (s.allowlistStart !== 0 && s.allowlistStart < s.publicStart) bounds.push({to: "allowlist", at: s.allowlistStart})
  if (s.publicStart !== 0) bounds.push({to: "public", at: s.publicStart})
  for (const b of bounds) if (b.at > nowSec) return b
  return null
}

/** Is the claim overlay live? Open-ended from `claimStart` — unlike the old
 *  partition, it does NOT close at `allowlistStart`; it stays available through
 *  allowlist and public so a punk owner can claim their own id whenever. */
export function claimOpen(s: Schedule, nowSec: number): boolean {
  return s.claimStart !== 0 && nowSec >= s.claimStart
}

/** Is punk-id reservation open? From schedule-set until `claimStart` — the window
 *  during which a holder can withhold their punk from the random draw pool.
 *  Reservation closes the instant claim opens (unclaimed reservations then ride
 *  out to release, per the contract's `releaseReserved`). */
export function reservationOpenAt(s: Schedule, nowSec: number): boolean {
  return s.claimStart !== 0 && nowSec < s.claimStart
}
