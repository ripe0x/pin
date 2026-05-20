"use client"

import type { Address } from "viem"
import { useIsCatalogOwner } from "./useIsCatalogOwner"
import { AddEntryForm, type ExistingRecord } from "./AddEntryForm"
import { ChainSwitcher } from "./ChainSwitcher"

/**
 * Manual single-entry "add a contract/token" form. Sits below the
 * pre-fill panel (when one renders) as the escape hatch for things
 * pnd's index doesn't know about: fresh deploys, niche contracts,
 * cross-chain assets we can't see.
 *
 * `prefillPanelPresent` reframes the form when the pre-fill panel
 * exists above it — collapses to a one-line "Add something we missed?"
 * disclosure so it doesn't compete with the pre-fill for primary
 * attention. Expands inline when the artist actually wants to add
 * something manually. When no pre-fill panel exists (no indexed work
 * at all), the form is always-expanded as the primary action.
 *
 * Owner-gated: the whole section returns null when the connected
 * wallet doesn't match the URL artist. ChainSwitcher inside ensures a
 * wallet on the wrong chain gets a clear path to fix it before trying
 * to sign.
 */
export function AddEntrySection({
  artist,
  existing,
  prefillPanelPresent = false,
}: {
  artist: Address
  existing: ExistingRecord
  /**
   * True when the IndexedWorkSection rendered above this on the page.
   * Lets the form collapse so the two "add" UIs don't compete.
   */
  prefillPanelPresent?: boolean
}) {
  const isOwner = useIsCatalogOwner(artist)
  if (!isOwner) return null

  // When the IndexedWorkSection is rendering the planner above this on
  // the page, the planner has its own inline "Add a contract we missed"
  // affordance (BatchAddRow) that contributes entries to the same
  // multicall. Don't render a second, separate manual form here — that
  // was the source of the "two UIs doing the same thing" confusion.
  // The standalone form is preserved for the no-pre-fill case (artist
  // with zero indexed work) where it's the only add path.
  if (prefillPanelPresent) return null

  return (
    <>
      <ChainSwitcher />
      <AddEntryForm existing={existing} />
    </>
  )
}
