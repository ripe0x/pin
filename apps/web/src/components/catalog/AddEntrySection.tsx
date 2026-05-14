"use client"

import type { Address } from "viem"
import { useIsCatalogOwner } from "./useIsCatalogOwner"
import { AddEntryForm, type ExistingRecord } from "./AddEntryForm"
import { ChainSwitcher } from "./ChainSwitcher"

/**
 * Wraps `AddEntryForm` with the owner gate so the page can render it
 * unconditionally — the form hides itself when the connected wallet
 * doesn't match the URL artist. ChainSwitcher renders above the form
 * so a wallet on the wrong chain gets a clear path to fix it before
 * trying to sign. The artist's current record is passed through so the
 * form can refuse duplicate submissions client-side instead of letting
 * the contract revert.
 */
export function AddEntrySection({
  artist,
  existing,
}: {
  artist: Address
  existing: ExistingRecord
}) {
  const isOwner = useIsCatalogOwner(artist)
  if (!isOwner) return null
  return (
    <>
      <ChainSwitcher />
      <AddEntryForm existing={existing} />
    </>
  )
}
