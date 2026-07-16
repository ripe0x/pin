import Link from "next/link"
import type { SeatState } from "@/lib/mint-onchain"

/**
 * The full set of seats for a shared-aggregate collection (Vouch: 52). Minted +
 * active seats are filled, minted-but-lapsed seats are outlined, unminted seats
 * are faint placeholders. Minted cells link to the per-piece page.
 */
export function SeatGrid({
  seats,
  collectionId,
  tokenNoun,
}: {
  seats: SeatState[]
  collectionId: string
  tokenNoun: string
}) {
  if (seats.length === 0) return null
  const mintedCount = seats.filter((s) => s.minted).length

  return (
    <section className="pt-5">
      <div className="flex items-baseline justify-between mb-3">
        <h2 className="text-[10px] font-mono uppercase tracking-wider text-gray-400">
          {tokenNoun}s
        </h2>
        <span className="text-[10px] font-mono uppercase tracking-wider text-gray-400 tabular-nums">
          {mintedCount} / {seats.length} minted
        </span>
      </div>
      <div
        className="grid gap-1"
        style={{ gridTemplateColumns: "repeat(13, minmax(0, 1fr))" }}
      >
        {seats.map((s) => {
          const base =
            "flex aspect-square items-center justify-center rounded-sm text-[8px] font-mono tabular-nums leading-none"
          if (!s.minted) {
            return (
              <div
                key={s.tokenId}
                className={`${base} border border-dashed border-gray-200 text-gray-300`}
                title={`${tokenNoun} #${s.tokenId} · open`}
              >
                {s.tokenId}
              </div>
            )
          }
          const style = s.active
            ? "bg-fg text-bg hover:opacity-80"
            : "border border-gray-300 text-gray-400 hover:border-fg"
          return (
            <Link
              key={s.tokenId}
              href={`/mint/${collectionId}/${s.tokenId}`}
              className={`${base} ${style} transition-colors`}
              title={`${tokenNoun} #${s.tokenId} · ${s.active ? "active" : "lapsed"}`}
            >
              {s.tokenId}
            </Link>
          )
        })}
      </div>
      <p className="mt-3 text-[10px] font-mono text-gray-400 leading-relaxed">
        Filled = active, outlined = lapsed (reclaimable), dashed = not yet minted.
      </p>
    </section>
  )
}
