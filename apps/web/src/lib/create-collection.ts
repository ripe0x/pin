/**
 * Shared, client-safe helpers for the studio create-collection wizard
 * (app/studio/[address]/create). Kept out of the components so the
 * validation/summary logic is independently testable and so the wizard
 * components stay focused on state + markup. previewURI decoding lives in
 * ./collection-preview.ts, shared with the collection page's pre-mint hero.
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
