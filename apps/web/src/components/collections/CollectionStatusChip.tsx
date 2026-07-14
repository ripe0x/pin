/**
 * Compact lifecycle status chip for a collection card: dot + label, plus an
 * "opens <relative>" caption while Scheduled. Presentation-only — the caller
 * (a server component today; nothing here is client-only) derives `status`/
 * `soldOut`/`opensInSec` once via `lifecycleStatus()` so every card and its
 * section grouping agree on the same read.
 *
 * Dot colors mirror MintCollectionCTA's status dot exactly (same status
 * tokens, same soldOut-vs-window-closed distinction) so the listing and the
 * collection page never disagree about what a state looks like.
 */
import { SurfaceStatus } from "@/lib/collection"

/** Small relative-time formatter for the listing's "opens in" caption.
 *  Deliberately duplicated (not imported) from tx-ui.tsx's formatRemaining:
 *  that module is "use client" and this chip renders on the server. Same
 *  d/h/m/s tiering, no seconds precision on the day/hour tiers. */
function formatOpensIn(secondsLeft: number): string {
  if (secondsLeft <= 0) return "now"
  const d = Math.floor(secondsLeft / 86400)
  const h = Math.floor((secondsLeft % 86400) / 3600)
  const m = Math.floor((secondsLeft % 3600) / 60)
  if (d > 0) return `${d}d ${h}h`
  if (h > 0) return `${h}h ${m}m`
  if (m > 0) return `${m}m`
  return `${secondsLeft}s`
}

export function CollectionStatusChip({
  status,
  soldOut,
  opensInSec,
}: {
  status: SurfaceStatus
  /** Only meaningful when status === Closed: distinguishes the celebratory
   *  sold-out terminal state from an honest window-closed state. */
  soldOut: boolean
  /** Seconds until mintStart, only when status === Scheduled. */
  opensInSec?: number | null
}) {
  const label =
    status === SurfaceStatus.Open
      ? "Open"
      : status === SurfaceStatus.Scheduled
        ? "Scheduled"
        : soldOut
          ? "Sold out"
          : "Closed"

  const dotClass =
    status === SurfaceStatus.Open
      ? "bg-status-available animate-pulse"
      : status === SurfaceStatus.Scheduled
        ? "bg-status-upcoming"
        : soldOut
          ? "bg-status-sold"
          : "bg-gray-400"

  return (
    <span className="inline-flex items-center gap-2 text-[10px] font-mono uppercase tracking-wider">
      <span className="inline-flex items-center gap-1.5 text-gray-500">
        <span className={`inline-block h-1.5 w-1.5 rounded-full ${dotClass}`} />
        {label}
      </span>
      {status === SurfaceStatus.Scheduled && opensInSec != null && (
        <span className="text-gray-400">· opens {formatOpensIn(opensInSec)}</span>
      )}
    </span>
  )
}
