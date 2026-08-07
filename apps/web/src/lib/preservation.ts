/**
 * Preservation grade: what a work needs to render, what is locked, and what
 * is fragile, derived from verifiable facts and never overstated.
 *
 * A pure function (facts in, grade + fact list out) so the whole matrix is
 * unit-testable and neither page fires a read to compute it. Callers assemble
 * `PreservationFacts` from the cached reads they already hold (the collection
 * config, a token's render shape, one cached renderer probe) and render the
 * returned fact list.
 *
 * Liveness tiers follow docs/pnd-surface-system.md and
 * docs/injection-convention.md:
 *   - pure          renders from chain data alone (archival-deterministic)
 *   - chain-live    reads other onchain contracts (their state can change)
 *   - external-live reads offchain URLs (fragile, honest about it)
 * plus solidity-svg as the gold shape: an SVG data URI with no script runtime.
 *
 * The 2026-07 surface reduction removed WorkConfig from the core, so there is
 * no onchain declaration of a work's tier yet. This model DERIVES what it can
 * and otherwise reports "not declared" rather than guessing. `declaredLiveness`
 * is where a future onchain declaration (a renderer template or registry that
 * carries the tier) plugs in; today it is fed by the editorial override map
 * below, for works whose behavior is known and reviewed.
 */

/** How the token's document is produced, read from its render shape. */
export type RuntimeKind = "solidity-svg" | "html-js" | "static-image" | "unknown"

/** Liveness tier: what the work reads at render time. */
export type LivenessTier = "pure" | "chain-live" | "external-live"

export type PreservationFacts = {
  /** Renderer pointer permanently pinned (isRendererLocked). */
  rendererLocked: boolean
  /** Render runtime, from the token's render shape. "unknown" at the
   *  collection level when no token has been sampled. */
  runtime: RuntimeKind
  /** Whether the renderer exposes onchain code refs (a cached `code()`
   *  probe). true = code stored onchain, false = no code refs (e.g. a
   *  static-image renderer), null = not probed / renderer has no such
   *  getter (a bespoke renderer). */
  codeOnchain: boolean | null
  /** A per-token static image distinct from the collection cover exists
   *  (RenderAssets capture). null at the collection level. */
  hasCapture: boolean | null
  /** A collection cover image is set. */
  hasCover: boolean
  /** Reviewed liveness declaration for known works. null = not declared;
   *  the model never invents one. `note` is collector-facing prose. */
  declared: { tier: LivenessTier; note: string } | null
}

export type FactTone = "good" | "neutral" | "caution"
export type PreservationFact = { label: string; tone: FactTone }

export type PreservationGrade = {
  /** A short label from the tier vocabulary, never a letter grade. */
  summary: string
  facts: PreservationFact[]
}

/**
 * Editorial liveness overrides, keyed by lowercase collection address. The
 * launch-descriptor pattern: reviewed, per-collection data rather than a
 * hardcoded component branch. Seeded with works whose render behavior is
 * known; a work not listed here reports "not declared" unless the runtime
 * shape lets the model derive a tier. Replace with an onchain declaration
 * when a renderer template or registry carries one.
 */
export const PRESERVATION_OVERRIDES: Record<
  string,
  { tier: LivenessTier; note: string }
> = {
  // Homage to the Punk: the renderer reads live CryptoPunks contract state
  // at tokenURI time, so the output tracks the source punk rather than
  // freezing at mint.
  "0xd938ff57d2c7111880a4ea5c8e6a92796c72a76e": {
    tier: "chain-live",
    note: "Reads live CryptoPunks onchain state",
  },
}

/** The editorial override for a collection, or null. */
export function preservationOverride(
  address: string,
): { tier: LivenessTier; note: string } | null {
  return PRESERVATION_OVERRIDES[address.trim().toLowerCase()] ?? null
}

/**
 * Derive the render runtime from a token's decoded render shape. An HTML
 * document animation_url is a script runtime; an SVG data URI with no such
 * document is the gold shape (assembled onchain, no JS); anything else is a
 * static image. "unknown" when there is nothing to sample (collection level,
 * or a token that has not resolved).
 */
export function runtimeKindOf(
  image: string | null | undefined,
  animationUrl: string | null | undefined,
): RuntimeKind {
  if (animationUrl && animationUrl.startsWith("data:text/html")) return "html-js"
  if (image && image.startsWith("data:image/svg")) return "solidity-svg"
  // A live document delivered by URL (e.g. a proxied onchain render) is not a
  // data URI we can classify, but it is a live render, not a static image.
  // Return unknown so no runtime fact is claimed rather than a false "static".
  if (animationUrl) return "unknown"
  if (image) return "static-image"
  return "unknown"
}

function runtimeFact(runtime: RuntimeKind): PreservationFact | null {
  switch (runtime) {
    case "solidity-svg":
      return { label: "Rendered as onchain SVG, no code runtime", tone: "good" }
    case "html-js":
      return { label: "Rendered by an onchain HTML and JavaScript document", tone: "neutral" }
    case "static-image":
      return { label: "Static image, no live render", tone: "neutral" }
    case "unknown":
      return null
  }
}

/**
 * Grade the preservation facts into a collector-facing fact list and a short
 * tier summary. Order of the summary label, most to least self-sufficient:
 * a derived "pure" (solidity-svg) leads, then a declared tier, then an
 * honest "not declared".
 */
export function gradePreservation(f: PreservationFacts): PreservationGrade {
  const facts: PreservationFact[] = []

  const rf = runtimeFact(f.runtime)
  if (rf) facts.push(rf)

  if (f.codeOnchain === true) {
    facts.push({ label: "Art code stored onchain", tone: "good" })
  }

  facts.push(
    f.rendererLocked
      ? { label: "Renderer locked permanently", tone: "good" }
      : { label: "Renderer can still be changed by the artist", tone: "caution" },
  )

  // Declared liveness (editorial today, onchain in future). Only asserted
  // when present; a chain-live or external-live read is surfaced as its own
  // honesty note.
  if (f.declared) {
    const tone: FactTone = f.declared.tier === "external-live" ? "caution" : "neutral"
    facts.push({ label: f.declared.note, tone })
  }

  // Image self-resolution. Never present a cover as the work, and never
  // present a chain-live snapshot as the canonical output (per
  // docs/pnd-surface-thumbnails.md): so a capture is only a "good" fact for
  // works that are not chain/external live.
  if (f.hasCapture === true) {
    const live = f.declared && f.declared.tier !== "pure"
    facts.push({
      label: live
        ? "Static image captured, a snapshot of a live work"
        : "Static image captured onchain",
      tone: live ? "neutral" : "good",
    })
  } else if (f.hasCapture === false) {
    facts.push({ label: "Static image not yet captured", tone: "neutral" })
  } else if (!f.hasCover) {
    facts.push({ label: "No cover image set", tone: "neutral" })
  }

  // Summary label from the tier vocabulary.
  let summary: string
  if (f.declared) {
    summary =
      f.declared.tier === "chain-live"
        ? "Chain-live"
        : f.declared.tier === "external-live"
          ? "External-live"
          : "Pure onchain"
  } else if (f.runtime === "solidity-svg" && f.codeOnchain !== false) {
    // Derivable: an SVG assembled onchain with no external runtime.
    summary = "Pure onchain"
  } else if (f.codeOnchain === true) {
    summary = "Onchain code, liveness not declared"
  } else {
    summary = "Liveness not declared"
  }

  return { summary, facts }
}
