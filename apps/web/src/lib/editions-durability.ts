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

/**
 * Human label for HOW LONG a hot pin is funded ahead, from now to its
 * funded-through date — e.g. "~3 years", "~8 months", "~1 year". This is the
 * "years pinned on IPFS" figure: the renewable Pinata term the accumulated mint
 * funding has bought ahead. "lapsed" once the date has passed.
 */
export function fundedForLabel(fundedThroughSec: number, nowSec: number): string {
  const secs = fundedThroughSec - nowSec
  if (secs <= 0) return "lapsed"
  const years = secs / (365 * 86_400)
  if (years >= 1) {
    const r = Math.round(years * 10) / 10
    const n = Number.isInteger(r) ? String(r) : r.toFixed(1)
    return `~${n} year${r === 1 ? "" : "s"}`
  }
  const months = Math.max(1, Math.round(secs / (30 * 86_400)))
  return `~${months} month${months === 1 ? "" : "s"}`
}

/**
 * Rough estimate of how many years of IPFS pinning the accrued permanence funds
 * buy, for a work of `artworkBytes`. Pinning is USD-priced (~$0.10/GB/mo =
 * $1.20/GB/yr by default), so this needs an ETH→USD assumption. It is an
 * ESTIMATE — the UI must show the assumptions and the figure is clamped for
 * display (see pinYearsLabel), because small works are so cheap to pin that any
 * meaningful slice over-funds them by orders of magnitude (which is the point:
 * permanence is cheap). The Arweave floor is pay-once and separate.
 */
export function estimatePinYears(opts: {
  accruedWei: bigint
  ethUsd: number
  artworkBytes: number
  usdPerGbYear?: number
}): number {
  const usdPerGbYear = opts.usdPerGbYear ?? 1.2
  const gb = opts.artworkBytes / 1e9
  if (gb <= 0 || opts.ethUsd <= 0 || usdPerGbYear <= 0) return 0
  const accruedEth = Number(opts.accruedWei) / 1e18
  const usd = accruedEth * opts.ethUsd
  return usd / (gb * usdPerGbYear)
}

/** Display label for an estimated pin-years figure, clamped so it never reads
 *  as an absurd number ("100+ years" past a century). */
export function pinYearsLabel(years: number): string {
  if (!(years > 0)) return "—"
  if (years >= 100) return "100+ years"
  if (years >= 1) {
    const r = Math.round(years)
    return `~${r} year${r === 1 ? "" : "s"}`
  }
  const m = Math.max(1, Math.round(years * 12))
  return `~${m} month${m === 1 ? "" : "s"}`
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
