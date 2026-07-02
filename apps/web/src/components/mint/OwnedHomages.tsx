"use client"

/**
 * "Your homages" — wallet-wide discovery for the redeem experience (Phase 4.4).
 * The Phase-3 redeem panel is per-token (it lives on the token page); this is
 * the entry point that lists every outstanding homage the connected wallet
 * holds, each linking to its token page where the redeem action lives.
 *
 * Reads the indexer (`/api/mint/[contract]/owned/[wallet]`), NOT the chain — no
 * wallet-side log scan. Fires only on wallet connect / address change, never
 * per render. Renders nothing when disconnected or when the wallet holds none
 * (or the indexer isn't live yet) so it stays invisible until it has something
 * to show.
 */

import { useEffect, useState } from "react"
import Link from "next/link"
import { useAccount } from "wagmi"

type OwnedHomage = { punkId: number; mintPhase: string | null; lastMintedAtTime: number }

export function OwnedHomages({ collectionId }: { collectionId: string }) {
  const { address } = useAccount()
  const [homages, setHomages] = useState<OwnedHomage[] | null>(null)

  useEffect(() => {
    if (!address) {
      setHomages(null)
      return
    }
    let cancelled = false
    setHomages(null)
    fetch(`/api/mint/${encodeURIComponent(collectionId)}/owned/${address}`)
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((d: { homages?: OwnedHomage[] }) => {
        if (!cancelled) setHomages(d.homages ?? [])
      })
      .catch(() => {
        if (!cancelled) setHomages([])
      })
    return () => {
      cancelled = true
    }
  }, [address, collectionId])

  // Invisible until there's something to show: disconnected, still loading, or
  // an empty result (holds none / indexer not live yet).
  if (!address || homages === null || homages.length === 0) return null

  return (
    <section className="py-5 border-b border-gray-100">
      <div className="flex items-baseline justify-between mb-3">
        <h2 className="text-[10px] font-mono uppercase tracking-wider text-gray-400">
          Your homages
        </h2>
        <span className="text-[10px] font-mono uppercase tracking-wider text-gray-400 tabular-nums">
          {homages.length} held
        </span>
      </div>
      <ul className="space-y-1.5">
        {homages.map((h) => (
          <li
            key={h.punkId}
            className="flex items-center justify-between gap-3 text-[11px] font-mono"
          >
            <Link
              href={`/mint/${collectionId}/${h.punkId}`}
              className="text-gray-600 hover:text-fg underline-offset-2 hover:underline"
            >
              Homage #{h.punkId}
            </Link>
            <Link
              href={`/mint/${collectionId}/${h.punkId}`}
              className="text-[10px] uppercase tracking-wider text-gray-400 hover:text-fg"
            >
              Redeem →
            </Link>
          </li>
        ))}
      </ul>
    </section>
  )
}
