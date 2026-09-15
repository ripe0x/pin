/**
 * Shared, client-safe helpers for the studio create-collection wizard
 * (app/studio/[address]/create). Kept out of the components so the
 * validation/decoding/summary logic is independently testable and so the
 * wizard components stay focused on state + markup.
 *
 * The wizard targets one artist: someone who already deployed their own
 * renderer contract and wants to launch a token contract against it. See
 * docs/pnd-surface-system.md, docs/injection-convention.md, and
 * contracts/src/surface/interfaces/IRenderer.sol / IPreviewRenderer.sol for
 * the source-of-truth shapes this mirrors.
 */

import { isAddress } from "viem"
import type { WizardState } from "@/components/studio/create/types"

// ── artwork URI ──────────────────────────────────────────────────────────

/** Schemes accepted for the wizard's optional cover-image URI field. */
export const ARTWORK_URI_SCHEMES = ["ipfs://", "ar://", "https://"] as const

/** True when `uri` is a `scheme://something` with a non-empty path. */
export function isValidArtworkURI(uri: string): boolean {
  const trimmed = uri.trim()
  return ARTWORK_URI_SCHEMES.some(
    (scheme) => trimmed.startsWith(scheme) && trimmed.length > scheme.length,
  )
}

// ── renderer address validation ─────────────────────────────────────────

/** Sync classification of the renderer address field's raw text, before any
 *  chain read. Drives the field's error message; `RendererStep` layers the
 *  async bytecode/preview check on top once this is "valid". */
export type RendererAddressSyntax = "empty" | "invalid" | "valid"

export function rendererAddressSyntax(input: string): RendererAddressSyntax {
  const trimmed = input.trim()
  if (trimmed === "") return "empty"
  return isAddress(trimmed) ? "valid" : "invalid"
}

/** True when a `getBytecode` result means a contract is deployed there
 *  (neither absent nor the empty-code sentinel an EOA or unused address
 *  returns). */
export function hasBytecode(code: `0x${string}` | undefined | null): boolean {
  return !!code && code !== "0x"
}

// ── preview decoding ────────────────────────────────────────────────────

export type PreviewDecodeResult =
  | { kind: "html"; html: string }
  | { kind: "image"; src: string }
  | { kind: "unsupported" }

/** Decode a `data:` URI into its content type and text body. Returns null
 *  for anything that isn't a `data:` URI or fails to decode. Browser-safe
 *  (atob/TextDecoder, no Buffer) so it runs in the wizard's client component
 *  as well as under node:test. */
function decodeDataUri(uri: string): { contentType: string; text: string } | null {
  const match = /^data:([^;,]*)(;base64)?,(.*)$/is.exec(uri.trim())
  if (!match) return null
  const contentType = (match[1] || "text/plain").toLowerCase()
  const isBase64 = !!match[2]
  try {
    if (isBase64) {
      const binary = atob(match[3])
      const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0))
      return { contentType, text: new TextDecoder().decode(bytes) }
    }
    return { contentType, text: decodeURIComponent(match[3]) }
  } catch {
    return null
  }
}

/**
 * Decode a renderer's `previewURI` return value into something the wizard
 * can display: an HTML document (sandboxed iframe srcdoc), an image (img
 * src), or unsupported (the renderer returned something that isn't a data
 * URI, or JSON with no image/animation_url field). Mirrors tokenURI output
 * shape: `data:application/json;base64,<...>` with `image` and/or
 * `animation_url` fields; `animation_url` wins when it decodes to inline
 * HTML.
 */
export function decodePreviewURI(uri: string): PreviewDecodeResult {
  const outer = decodeDataUri(uri)
  if (!outer) return { kind: "unsupported" }
  if (outer.contentType.startsWith("image/")) return { kind: "image", src: uri }
  if (!outer.contentType.includes("json")) return { kind: "unsupported" }

  let meta: { image?: unknown; animation_url?: unknown }
  try {
    meta = JSON.parse(outer.text)
  } catch {
    return { kind: "unsupported" }
  }

  const animation = typeof meta.animation_url === "string" ? meta.animation_url.trim() : ""
  if (animation) {
    const inner = decodeDataUri(animation)
    if (inner && inner.contentType.includes("html")) return { kind: "html", html: inner.text }
  }

  const image = typeof meta.image === "string" ? meta.image.trim() : ""
  if (image) return { kind: "image", src: image }

  return { kind: "unsupported" }
}

// ── review summary ──────────────────────────────────────────────────────

export type SummaryRow = { label: string; value: string }

function formatWindow(state: WizardState): string {
  if (!state.hasWindow) return "Open now, no end"
  const start = state.startAt ? new Date(state.startAt).toLocaleString() : "now"
  const end = state.endAt ? new Date(state.endAt).toLocaleString() : "no end"
  return `${start} to ${end}`
}

/** Builds the Review step's field-by-field summary from wizard state. Pure
 *  (no chain reads): `priceEthLabel` is the already-formatted price string
 *  (e.g. from useEthAmountInput's rawValue) so this stays chain/hook-free. */
export function buildReviewSummary(state: WizardState, priceEthLabel: string): SummaryRow[] {
  return [
    { label: "Renderer", value: state.rendererAddress || "None" },
    { label: "Name", value: state.name || "None" },
    { label: "Symbol", value: state.symbol || "None" },
    { label: "Price", value: priceEthLabel.trim() === "" ? "0 ETH (gas only)" : `${priceEthLabel} ETH` },
    { label: "Supply", value: state.openSupply ? "Open (no cap)" : state.supplyCap || "None" },
    { label: "Mint window", value: formatWindow(state) },
    { label: "Royalty", value: `${state.royaltyPct || "0"}%` },
    { label: "Payout", value: state.payout || "You (connected wallet)" },
    {
      label: "Collaborators",
      value:
        state.collaborators.filter((r) => r.address.trim() !== "").length > 0
          ? state.collaborators
              .filter((r) => r.address.trim() !== "")
              .map((r) => r.address)
              .join(", ")
          : "None",
    },
    { label: "Cover image", value: state.artworkURI || "None" },
  ]
}
