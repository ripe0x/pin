"use client"

import type { Address } from "viem"
import { useIsStudioOwner } from "@/components/studio/useIsStudioOwner"
import { OperatorEditPanel } from "./OperatorEditPanel"

/**
 * Operator section is edit-only — the registry has no way to
 * enumerate operators, so there's nothing to render on the read side.
 * The whole section is hidden when the connected wallet doesn't own
 * the record.
 */
export function CatalogOperatorEditable({ artist }: { artist: Address }) {
  const isOwner = useIsStudioOwner(artist)
  if (!isOwner) return null
  return (
    <section className="space-y-3">
      <h2 className="text-lg font-semibold">Operators</h2>
      <OperatorEditPanel artist={artist} />
    </section>
  )
}
