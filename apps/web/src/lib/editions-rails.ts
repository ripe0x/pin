/**
 * PND Editions — pluggable permanence spend rails (Phase 2 of
 * docs/editions-permanence-funding.md).
 *
 * A "rail" turns the artist's permanence-vault ETH into a durable or available
 * copy of the artwork and reports the URI(s) to register as MURI fallbacks plus
 * an HONEST durability label. The interface is pluggable so backends are
 * swappable (Irys/Arweave floor today; Pinata-x402 hot layer and
 * Storacha/Filecoin later) without changing the vault or the contract.
 *
 * This module is enum-free (only union types + pure helpers) so it loads under
 * Node's type-stripping test runner. The concrete Irys adapter, which imports
 * the storage substrate + Irys SDK, lives in editions-rail-irys.ts.
 *
 * Honest-status rule, encoded here: durability is EARNED, never assumed. A
 * pay-once Arweave copy is only "permanent-floor" once arweave.net actually
 * serves it; until then it is "irys-stored" (durable, Arweave settlement
 * unconfirmed). A renewable pin is always "rented-hot" with a funded-through
 * date, never "permanent". See §3 + the Phase 0 note in the design doc.
 */

/** Which storage backend a spend rail funds. */
export type RailKind = "irys-arweave" | "pinata-x402" | "storacha-filecoin"

/**
 * The realized, honest durability of what a rail produced.
 *   - permanent-floor: settled to Arweave; arweave.net serves it (earned).
 *   - irys-stored:     durable on Irys, but Arweave settlement not confirmed.
 *   - rented-hot:      a renewable pin that lapses without funding.
 *   - unconfirmed:     uploaded, but nothing has resolved it yet.
 */
export type RailDurability = "permanent-floor" | "irys-stored" | "rented-hot" | "unconfirmed"

export type RailQuote = {
  bytes: number
  /** One-time storage cost in wei (native mainnet ETH). 0n when free. */
  wei: bigint
  /** True under the provider's free tier (no funding tx). */
  isFree: boolean
  /** unix seconds the funded term lasts; null = pay-once / permanent floor. */
  fundedThrough: number | null
}

export type RailFundResult = {
  /** URIs to register as MURI fallbacks (addArtworkUris), most-durable first. */
  uris: string[]
  /** The EARNED durability (from which gateways actually resolved the bytes). */
  durability: RailDurability
  /** unix seconds the funded term lasts; null = pay-once / permanent floor. */
  fundedThrough: number | null
  /** Onchain spend tx hashes, for the audit trail. */
  spendTxs: `0x${string}`[]
}

/**
 * A swappable storage spend rail. Concrete rails (editions-rail-irys.ts, and
 * later Pinata-x402 / Storacha) implement this so the funding UI and the keeper
 * treat every backend uniformly.
 */
export interface SpendRail<QuoteInput = unknown, FundInput = unknown> {
  kind: RailKind
  /** What this rail AIMS for; the realized durability is earned per fund(). */
  targetDurability: "permanent-floor" | "rented-hot"
  quote(input: QuoteInput): Promise<RailQuote>
  fund(input: FundInput): Promise<RailFundResult>
}

// ── pure helpers (tested in editions-rails.test.ts) ──────────────────────────

/** Strip an `ar://` / gateway prefix down to the bare Arweave/Irys id. */
export function bareArweaveId(idOrUri: string): string {
  return idOrUri
    .trim()
    .replace(/^ar:\/\//i, "")
    .replace(/^https?:\/\/(?:arweave\.net|gateway\.irys\.xyz)\//i, "")
    .replace(/^\/+/, "")
}

/**
 * The ordered fallback URI set for an Arweave/Irys id, most-durable first:
 * the canonical `ar://`, the Arweave gateway (proves Arweave settlement), then
 * the Irys gateway (serves optimistically before settlement). These go into
 * MURI via addArtworkUris so the onchain viewer shows the first surviving copy.
 */
export function deriveArweaveUris(idOrUri: string): string[] {
  const id = bareArweaveId(idOrUri)
  if (!id) return []
  return [`ar://${id}`, `https://arweave.net/${id}`, `https://gateway.irys.xyz/${id}`]
}

/**
 * EARN the durability label from which gateways actually served the bytes.
 * arweave.net resolving is the proof of Arweave settlement → "permanent-floor".
 * Only the Irys gateway resolving → "irys-stored" (durable, settlement
 * unconfirmed; arweave.net can lag until the bundle finalizes, so re-check
 * later — this is the Phase 3 decay-monitor's job). Neither → "unconfirmed".
 */
export function arweaveDurability(opts: {
  arweaveResolved: boolean
  irysResolved: boolean
}): RailDurability {
  if (opts.arweaveResolved) return "permanent-floor"
  if (opts.irysResolved) return "irys-stored"
  return "unconfirmed"
}

/** Human label for a durability state (UI badge). */
export function durabilityLabel(d: RailDurability): string {
  switch (d) {
    case "permanent-floor":
      return "Permanent (Arweave)"
    case "irys-stored":
      return "Stored via Irys (Arweave settlement unconfirmed)"
    case "rented-hot":
      return "Pinned (funded for a term)"
    case "unconfirmed":
      return "Uploaded (not yet retrievable)"
  }
}
