// Homage mint schedule → current window + next transition. Mirrors HomageMinter's
// gating exactly (ported from the homage repo's lib/phase.ts, byte-for-byte logic):
//   claim     [claimStart, allowlistStart)   punk owners mint their own tokenId
//   allowlist [allowlistStart, publicStart)  allowlisted addrs, random draw
//   public    [publicStart, ∞)               anyone, random draw
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
export function nextTransition(s: Schedule, nowSec: number): {to: Phase; at: number} | null {
  const bounds: {to: Phase; at: number}[] = []
  if (s.claimStart !== 0 && s.claimStart < s.allowlistStart) bounds.push({to: "claim", at: s.claimStart})
  if (s.allowlistStart !== 0 && s.allowlistStart < s.publicStart) bounds.push({to: "allowlist", at: s.allowlistStart})
  if (s.publicStart !== 0) bounds.push({to: "public", at: s.publicStart})
  for (const b of bounds) if (b.at > nowSec) return b
  return null
}
