"use client"

import { useState } from "react"
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
  const [expanded, setExpanded] = useState(!prefillPanelPresent)
  if (!isOwner) return null

  if (prefillPanelPresent && !expanded) {
    return (
      <button
        type="button"
        onClick={() => setExpanded(true)}
        className="w-full flex items-center justify-between border border-gray-200 rounded-md px-4 py-2.5 hover:bg-gray-50 text-left transition-colors"
      >
        <span className="text-sm">
          <span className="font-medium">Add a contract we missed</span>
          <span className="text-gray-500 ml-2">
            fresh deploy, niche contract, etc.
          </span>
        </span>
        <span className="text-xs text-gray-500 underline">Expand</span>
      </button>
    )
  }

  return (
    <section className="border border-gray-200 rounded-md p-4">
      {prefillPanelPresent && (
        <header className="flex items-start justify-between gap-4 mb-3">
          <div className="min-w-0 flex-1">
            <h2 className="text-sm font-semibold">Add a contract we missed</h2>
            <p className="text-xs text-gray-500 mt-1">
              For fresh deploys or anything not in your indexed work above.
              Single-entry — type the contract address, optionally pick
              token IDs.
            </p>
          </div>
          <button
            type="button"
            onClick={() => setExpanded(false)}
            className="text-xs text-gray-500 hover:text-gray-900 underline shrink-0"
          >
            Minimize
          </button>
        </header>
      )}
      <ChainSwitcher />
      <AddEntryForm existing={existing} />
    </section>
  )
}
