import Link from "next/link"
import { shortAddress } from "@/lib/pnd-editions"
import type { SeatState } from "@/lib/mint-onchain"

/**
 * Newest seats first, with their current holder. Derived from live seat state
 * (cached-reads-only — no event log), so this is current occupancy, not mint
 * provenance: for a sequential mint the highest ids are the most recent, and
 * the holder shown is who owns the seat now (a claimed seat shows its claimer).
 */
export function RecentMints({
  seats,
  collectionId,
  tokenNoun,
  limit = 12,
}: {
  seats: SeatState[]
  collectionId: string
  tokenNoun: string
  limit?: number
}) {
  const recent = seats
    .filter((s) => s.minted)
    .sort((a, b) => b.tokenId - a.tokenId)
    .slice(0, limit)
  if (recent.length === 0) return null

  return (
    <section className="py-5 border-b border-gray-100">
      <h2 className="text-[10px] font-mono uppercase tracking-wider text-gray-400 mb-3">
        Latest {tokenNoun}s
      </h2>
      <ul className="space-y-1.5">
        {recent.map((s) => (
          <li key={s.tokenId} className="flex items-center justify-between gap-3 text-[11px] font-mono">
            <Link
              href={`/mint/${collectionId}/${s.tokenId}`}
              className="text-gray-600 hover:text-fg underline-offset-2 hover:underline"
            >
              {tokenNoun} #{s.tokenId}
            </Link>
            <span className="flex items-center gap-2 text-gray-500">
              <span className="tabular-nums">{s.owner ? shortAddress(s.owner) : "—"}</span>
              <span
                className={`inline-block h-1.5 w-1.5 rounded-full ${s.active ? "bg-emerald-500" : "bg-gray-300"}`}
                title={s.active ? "active" : "lapsed"}
              />
            </span>
          </li>
        ))}
      </ul>
    </section>
  )
}
