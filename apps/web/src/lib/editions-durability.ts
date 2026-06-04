/**
 * The DURABILITY dimension of an edition's media (Phase 3 of
 * docs/editions-permanence-funding.md).
 *
 * Orthogonal to retrievability (editions-persistence-status.ts): retrievability
 * answers "did a gateway serve it at the last check"; durability answers "how
 * long will it stay alive, and is that permanent or rented". An edition can be
 * retrievable AND permanent-floor, or retrievable AND only hot-funded (fast now,
 * durable never), or unretrievable AND lapsed (the failure the badge must show).
 *
 * Honest-status rule, encoded here so the UI can't violate it:
 *   - "permanent-floor": an Arweave copy that ACTUALLY resolved (earned). The
 *     only state that may read as "permanent".
 *   - "hot-funded": a renewable pin funded through a known future date. Never
 *     "permanent" — it lapses without renewal.
 *   - "hot-lapsed": a previously-funded hot pin whose date has passed, with no
 *     permanent floor. The honest "this is rotting" state.
 *   - "none": no durable floor and no funded hot pin recorded.
 *
 * Pure + enum-free so it unit-tests under Node's type-stripping runner. No DB.
 */

export type ArtworkDurability = "permanent-floor" | "hot-funded" | "hot-lapsed" | "none"

export type DurabilityInput = {
  /** Content-address kind of the artwork URI (from classifyArtworkKey). */
  kind: "ipfs" | "arweave" | "external" | "none"
  /** cid_availability verdict: a gateway served it (true/false/null=unprobed). */
  retrievable: boolean | null
  /** unix seconds a hot pin is funded through; null = none recorded. */
  fundedThrough?: number | null
  /** current unix seconds. */
  nowSec: number
}

/**
 * Resolve the durability state. A resolved Arweave copy is the durable floor
 * (earned — it actually served). Otherwise a recorded hot pin is funded until
 * its date, then lapsed. The floor wins over a hot pin: if both exist, the work
 * is permanently floored regardless of the hot pin's date.
 */
export function resolveArtworkDurability(i: DurabilityInput): ArtworkDurability {
  if (i.kind === "arweave" && i.retrievable === true) return "permanent-floor"
  if (i.fundedThrough != null) {
    return i.fundedThrough > i.nowSec ? "hot-funded" : "hot-lapsed"
  }
  return "none"
}

export type RenewalSignal = "ok" | "due-soon" | "lapsed" | "none"

/**
 * When should the keeper renew a hot pin? Pure; this is what the Phase 5 keeper
 * (artist-as-keeper) acts on and what drives the "your pins need renewing"
 * nudge. "none" when there's nothing renewable (no funded-through recorded).
 */
export function renewalSignal(i: {
  fundedThrough?: number | null
  nowSec: number
  leadSec: number
}): RenewalSignal {
  if (i.fundedThrough == null) return "none"
  if (i.fundedThrough <= i.nowSec) return "lapsed"
  if (i.fundedThrough - i.nowSec <= i.leadSec) return "due-soon"
  return "ok"
}

/** UI guard: ONLY permanent-floor may ever read as permanent. */
export function durabilityIsPermanent(d: ArtworkDurability): boolean {
  return d === "permanent-floor"
}

/** Deterministic UTC `YYYY-MM-DD` for a unix-seconds timestamp. */
export function formatFundedThrough(sec: number): string {
  return new Date(sec * 1000).toISOString().slice(0, 10)
}

/** Honest human label for a durability state. */
export function durabilityLabel(d: ArtworkDurability, fundedThrough?: number | null): string {
  switch (d) {
    case "permanent-floor":
      return "Permanent floor (Arweave)"
    case "hot-funded":
      return fundedThrough != null
        ? `Pinned, funded through ${formatFundedThrough(fundedThrough)}`
        : "Pinned (funded)"
    case "hot-lapsed":
      return "Pin lapsed"
    case "none":
      return "No durable floor"
  }
}
