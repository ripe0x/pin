"use client"

import type { Address } from "viem"
import { useIsRecordOwner } from "./useIsRecordOwner"
import { AddEntryForm } from "./AddEntryForm"

/**
 * Wraps `AddEntryForm` with the owner gate so the page can render it
 * unconditionally — the form hides itself when the connected wallet
 * doesn't match the URL artist.
 */
export function AddEntrySection({ artist }: { artist: Address }) {
  const isOwner = useIsRecordOwner(artist)
  if (!isOwner) return null
  return <AddEntryForm />
}
