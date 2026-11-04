"use client"

/**
 * Picks a studio tool's panel by what the collection is: a primitive v2
 * Surface (proven by the token factory, never by version() alone) gets the v2
 * panel; a superseded August v2 Surface (Sepolia only) gets a read-only
 * notice, since its ABI is no longer one PND writes through; everything else
 * (v1 collections, and addresses outside the Surface set, whose v1 panels
 * already say so) gets the existing v1 panel unchanged.
 */

import { useCallback, useEffect, useState } from "react"
import { ERROR } from "@/components/studio/create/wizard-ui"
import { isSupersededV2, type SurfaceV2State } from "@/lib/surface-v2-studio"
import { fetchSurfaceV2, type V2Lookup } from "./v2-api"
import { Notice } from "./ui"

export function V2Router({
  collection,
  renderV1,
  renderV2,
}: {
  collection: `0x${string}`
  renderV1: () => React.ReactNode
  renderV2: (state: SurfaceV2State, refetch: () => void) => React.ReactNode
}) {
  const [lookup, setLookup] = useState<V2Lookup | undefined>(undefined)
  const load = useCallback(
    (quiet: boolean) => {
      if (!quiet) setLookup(undefined)
      void fetchSurfaceV2(collection).then(setLookup)
    },
    [collection],
  )
  useEffect(() => {
    load(false)
  }, [load])
  // Re-reads after a write keep the panel mounted (no loading flash, form
  // fields keep their values).
  const refetch = useCallback(() => load(true), [load])

  if (lookup === undefined) {
    return <p className="text-[11px] font-mono text-gray-400">Reading this collection…</p>
  }
  if (lookup === null) {
    return (
      <div className="space-y-2">
        <p className={ERROR}>Could not read this collection. Check the address and try again.</p>
        <button
          type="button"
          onClick={() => load(false)}
          className="text-[10px] font-mono uppercase tracking-wider text-gray-400 hover:text-fg underline"
        >
          Retry
        </button>
      </div>
    )
  }
  if (lookup === "not-surface") return <>{renderV1()}</>
  if (lookup.primitiveV2) return <>{renderV2(lookup, refetch)}</>
  if (isSupersededV2(lookup)) {
    return (
      <Notice>
        This collection was made by the superseded August Surface v2 factory (Sepolia only). PND no longer
        writes through that contract version, so its settings are read-only here. Its onchain state is
        unchanged and still readable on its collection page.
      </Notice>
    )
  }
  return <>{renderV1()}</>
}
