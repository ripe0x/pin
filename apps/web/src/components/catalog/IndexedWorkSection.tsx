"use client"

import { useState } from "react"
import type { Address } from "viem"
import type { NormalizedPlan } from "@/lib/import-sources/types"
import { useIsCatalogOwner } from "./useIsCatalogOwner"
import { ImportPlanner } from "./ImportPlanner"
import { INDEXED_PLATFORM_NAMES } from "@/lib/indexed-platforms"

/**
 * Inline panel on `/catalog/[address]` that pre-seeds the Catalog form
 * with the artist's already-indexed work. Only shown when the connected
 * wallet matches the URL artist (same gate as `AddEntrySection`).
 *
 * The plan is fetched server-side by the page (so the empty-state check
 * doesn't require a client roundtrip) and passed in fully-normalized.
 * If the plan is empty (no indexed work or everything already on
 * Catalog), the parent renders null and this never mounts.
 *
 * Wraps the existing `ImportPlanner` UI 1:1 — same checkbox + per-
 * contract "whole vs specific" mode + multicall signing flow that lives
 * at `/artist/[address]/import?source=pnd-indexed`. We render it here
 * too so artists don't have to navigate away from /catalog to seed
 * their declarations from indexed data.
 */
export function IndexedWorkSection({
  artist,
  plan,
  fetchError,
}: {
  artist: Address
  plan: NormalizedPlan
  fetchError: string | null
}) {
  const isOwner = useIsCatalogOwner(artist)
  const [minimized, setMinimized] = useState(false)
  if (!isOwner) return null
  if (plan.ops.length === 0 && plan.alreadyIndexed.length === 0) return null

  const indexedCount = plan.ops.reduce(
    (n, op) =>
      n +
      (op.kind === "addToken"
        ? 1
        : op.kind === "addTokenRange"
          ? Number(op.end - op.start + 1n)
          : op.works.length),
    0,
  )

  if (minimized) {
    return (
      <button
        type="button"
        onClick={() => setMinimized(false)}
        className="w-full flex items-center justify-between border border-gray-200 rounded-md px-4 py-2.5 bg-gray-50/50 hover:bg-gray-100 text-left transition-colors"
      >
        <span className="text-sm">
          <span className="font-medium">
            Pre-fill from your indexed work
          </span>
          <span className="text-gray-500 ml-2">
            {indexedCount} {indexedCount === 1 ? "entry" : "entries"} ready
          </span>
        </span>
        <span className="text-xs text-gray-500 underline">Expand</span>
      </button>
    )
  }

  return (
    <section className="border border-gray-200 rounded-md p-4 bg-gray-50/50">
      <header className="flex items-start justify-between gap-4 mb-3">
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-semibold">
            Pre-fill from your indexed work
          </h2>
          <p className="text-xs text-gray-500 mt-1">
            We&rsquo;ve indexed your contracts and tokens across{" "}
            <span className="relative inline-block group">
              <span
                tabIndex={0}
                aria-describedby="pnd-sources-tooltip"
                className="underline decoration-dotted decoration-gray-400 underline-offset-2 cursor-help focus:outline-none"
              >
                PND&rsquo;s sources
              </span>
              <span
                id="pnd-sources-tooltip"
                role="tooltip"
                className="pointer-events-none absolute left-0 top-full z-10 mt-1.5 whitespace-nowrap rounded-md bg-fg px-2.5 py-1.5 text-[11px] font-medium text-bg shadow-md opacity-0 transition-opacity duration-100 group-hover:opacity-100 group-focus-within:opacity-100"
              >
                Indexed: {INDEXED_PLATFORM_NAMES.join(", ")}
              </span>
            </span>
            . Select what you want to declare on Catalog — one signature
            does the whole batch.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setMinimized(true)}
          className="text-xs text-gray-500 hover:text-gray-900 underline shrink-0"
        >
          Minimize
        </button>
      </header>
      <ImportPlanner
        artistAddress={artist}
        sourceName="Your indexed work"
        sourceUrl={`/artist/${artist.toLowerCase()}`}
        plan={plan}
        fetchError={fetchError}
        embedded
      />
    </section>
  )
}
