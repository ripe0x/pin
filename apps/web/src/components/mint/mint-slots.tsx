"use client"

/**
 * Per-collection component slots for the mint surface. Two registries, both
 * keyed by strings the descriptor declares:
 *
 *   - lifecycle panels (`desc.lifecyclePanel`) — the per-token action panel on
 *     `/mint/[contract]/[tokenId]`. Replaces the old hardcoded coupling to
 *     Vouch's five-function seat shape: the token page renders whatever panel
 *     the collection registered (Vouch: renew/claim; a redeem flow next).
 *   - selectors (`phase.selector`, or the collection-level `desc.selector`
 *     for non-phased mints) — the in-MintPanel picker that produces the
 *     `selection` an args builder consumes (Vouch: pick an open seat; Homage:
 *     "pick which of your punks to claim"). No-selection mints just omit it.
 *
 * Registration lives HERE, at module scope, next to the components — same
 * pattern as the provider registries in mint-registries.ts. A new collection
 * adds one import + one register call (or a `mint-modules/<slug>` side-effect
 * module imported here). The Slot components do the lookup client-side, so
 * server pages pass only plain data props across the RSC boundary.
 */

import type { ComponentType } from "react"
import { SeatLifecyclePanel } from "./SeatLifecyclePanel"
import { VouchSeatPicker } from "./VouchSeatPicker"

// ── lifecycle panels (2.6) ──────────────────────────────────────────────────

/**
 * The data contract between the token page and a lifecycle panel: the piece's
 * server-read state plus the collection snapshot price. Panels needing more
 * (an exit fee, a wallet's related tokens) read it client-side themselves —
 * on mount/wallet-change, never per render.
 */
export type LifecyclePanelProps = {
  /** Slug or address — resolved against the registry client-side. */
  collectionId: string
  tokenId: number
  owner: string | null
  active: boolean
  expiresAt: number // unix seconds, 0 if not applicable
  freshnessBps: number
  priceWei: string
}

const lifecyclePanels = new Map<string, ComponentType<LifecyclePanelProps>>()

export function registerLifecyclePanel(
  key: string,
  panel: ComponentType<LifecyclePanelProps>,
): void {
  lifecyclePanels.set(key, panel)
}

/**
 * Renders the collection's registered lifecycle panel, or nothing when the
 * key is unknown (a descriptor referencing an unregistered panel fails soft —
 * the token page still renders).
 */
export function LifecyclePanelSlot({
  panelKey,
  ...props
}: LifecyclePanelProps & { panelKey: string }) {
  const Panel = lifecyclePanels.get(panelKey)
  if (!Panel) return null
  return <Panel {...props} />
}

// Vouch's seat panel (renew while active / claim once lapsed) — referenced by
// its descriptor via `lifecyclePanel: "vouch-seat"`.
registerLifecyclePanel("vouch-seat", SeatLifecyclePanel)

// ── phase selectors (2.3 companion) ─────────────────────────────────────────

export type PhaseSelectorProps = {
  /** Active phase key, or null for non-phased collections (Vouch). */
  phaseKey: string | null
  /** The `data` payload from the phase's eligibility provider (e.g. owned ids). */
  eligibilityData: unknown
  /**
   * Server-fetched context the page already had (passed through MintPanel's
   * `selectorData` prop) — e.g. Vouch's seat states, fetched once for
   * SeatGrid. Selectors should prefer this over issuing their own reads.
   */
  serverData: unknown
  /** Current selection, owned by MintPanel and passed to the args builder. */
  selection: unknown
  onSelect: (selection: unknown) => void
  /** True while a write is pending — selectors should disable input. */
  disabled: boolean
}

const phaseSelectors = new Map<string, ComponentType<PhaseSelectorProps>>()

export function registerPhaseSelector(
  key: string,
  selector: ComponentType<PhaseSelectorProps>,
): void {
  phaseSelectors.set(key, selector)
}

export function PhaseSelectorSlot({
  selectorKey,
  ...props
}: PhaseSelectorProps & { selectorKey: string }) {
  const Selector = phaseSelectors.get(selectorKey)
  if (!Selector) return null
  return <Selector {...props} />
}

// Vouch's chosen-seat picker — the descriptor's `selector: "vouch-seat"`,
// paired with the args builder registered under the same key.
registerPhaseSelector("vouch-seat", VouchSeatPicker)
