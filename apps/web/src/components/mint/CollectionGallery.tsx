"use client"

/**
 * The full collection as a thumbnail grid — every minted piece's onchain art,
 * each linking to its token detail page. Fetched on-demand from the gallery API
 * the first time it mounts (i.e. when the user toggles to it). Thumbnails are
 * plain `<img>` of the SVG data-URI: the CSS animation still runs, it's far
 * lighter than one sandboxed iframe per token, and the fully-interactive render
 * stays on the token detail page.
 */

import { useEffect, useState } from "react"
import Link from "next/link"

type Tok = { tokenId: number; imageUrl: string; active: boolean; owner: string | null }

export function CollectionGallery({
  collectionId,
  aspectRatio,
}: {
  collectionId: string
  aspectRatio?: string
}) {
  const [tokens, setTokens] = useState<Tok[] | null>(null)
  const [error, setError] = useState(false)

  useEffect(() => {
    let cancelled = false
    setTokens(null)
    setError(false)
    fetch(`/api/mint/${encodeURIComponent(collectionId)}/gallery`)
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((d: { tokens?: Tok[] }) => {
        if (!cancelled) setTokens(d.tokens ?? [])
      })
      .catch(() => {
        if (!cancelled) setError(true)
      })
    return () => {
      cancelled = true
    }
  }, [collectionId])

  if (error) {
    return <Note>Couldn&apos;t load the collection.</Note>
  }
  if (tokens === null) {
    return <Note>Loading collection…</Note>
  }
  if (tokens.length === 0) {
    return <Note>No pieces minted yet.</Note>
  }

  return (
    <div className="w-full max-h-[calc(100vh-220px)] overflow-y-auto">
      <div
        className="grid gap-3"
        style={{ gridTemplateColumns: "repeat(auto-fill, minmax(116px, 1fr))" }}
      >
        {tokens.map((t) => (
          <Link key={t.tokenId} href={`/mint/${collectionId}/${t.tokenId}`} className="group block">
            <div
              className="overflow-hidden rounded bg-[#08090a] ring-1 ring-white/5 group-hover:ring-white/20 transition"
              style={{ aspectRatio: aspectRatio ?? "1 / 1" }}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={t.imageUrl}
                alt={`#${t.tokenId}`}
                loading="lazy"
                className="h-full w-full object-contain"
              />
            </div>
            <div className="mt-1 flex items-center justify-between text-[10px] font-mono text-gray-500">
              <span className="tabular-nums">#{t.tokenId}</span>
              <span
                className={`inline-block h-1.5 w-1.5 rounded-full ${t.active ? "bg-emerald-500" : "bg-gray-300"}`}
                title={t.active ? "active" : "lapsed"}
              />
            </div>
          </Link>
        ))}
      </div>
    </div>
  )
}

function Note({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-[40vh] w-full items-center justify-center text-[11px] font-mono text-gray-400">
      {children}
    </div>
  )
}
