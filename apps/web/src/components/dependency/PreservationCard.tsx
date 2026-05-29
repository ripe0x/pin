import type {
  AreaEntry,
  PreservationSummary,
} from "@/lib/dependency-check"
import { StatusBadge } from "./StatusBadge"

/**
 * Full-width Preservation card. Replaces the single-line summary
 * rendering AreasToReview gives the rest of the entries with a
 * per-bucket breakdown:
 *
 *   IPFS         — retrievable bar + (retrievable / unprobed / failing
 *                  / artist-pinned) counts
 *   Arweave      — total CIDs + retrievable / unprobed
 *   On-chain     — trivially preserved count
 *   Centralized  — total URLs + top hosts list
 *
 * Driven by `report.preservation`; the matching AreaEntry supplies
 * status + canCheckNow + the NotYet whatWouldHelp text.
 */
export function PreservationCard({
  entry,
  preservation,
}: {
  entry: AreaEntry
  preservation: PreservationSummary
}) {
  const { ipfs, arweave, onchain, centralized } = preservation
  const anyData =
    ipfs.totalCids > 0 ||
    arweave.totalCids > 0 ||
    onchain.totalCount > 0 ||
    centralized.totalCount > 0

  return (
    <div
      className={`border rounded-md p-4 space-y-4 ${
        entry.canCheckNow ? "border-gray-200" : "border-dashed border-gray-200"
      }`}
    >
      <div className="flex items-start justify-between gap-3">
        <h3
          className={`font-medium ${
            entry.canCheckNow ? "" : "text-gray-700"
          }`}
        >
          {entry.title}
        </h3>
        <StatusBadge status={entry.status} />
      </div>

      {!anyData ? (
        <p className="text-sm text-gray-500">{entry.summary}</p>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Bucket
            label="IPFS"
            total={ipfs.totalCids}
            unit="CIDs"
            retrievable={ipfs.retrievableCount}
            denominator={
              ipfs.retrievableCount +
              ipfs.unretrievableCount +
              ipfs.unprobedCount
            }
            details={[
              ipfs.unretrievableCount > 0
                ? { label: "failing", count: ipfs.unretrievableCount, tone: "warn" as const }
                : null,
              ipfs.unprobedCount > 0
                ? { label: "not yet probed", count: ipfs.unprobedCount, tone: "muted" as const }
                : null,
              ipfs.artistPinnedCount > 0
                ? { label: "artist-pinned", count: ipfs.artistPinnedCount, tone: "good" as const }
                : null,
            ].filter((x): x is Exclude<typeof x, null> => x !== null)}
          />

          <Bucket
            label="Arweave"
            total={arweave.totalCids}
            unit="CIDs"
            retrievable={arweave.retrievableCount}
            denominator={arweave.retrievableCount + arweave.unprobedCount}
            details={
              arweave.unprobedCount > 0
                ? [
                    {
                      label: "not yet probed",
                      count: arweave.unprobedCount,
                      tone: "muted" as const,
                    },
                  ]
                : []
            }
          />

          <Bucket
            label="On-chain"
            total={onchain.totalCount}
            unit="references"
            retrievable={onchain.totalCount}
            denominator={onchain.totalCount}
            details={[]}
            hint={
              onchain.totalCount > 0
                ? "Stored in contract storage — trivially preserved."
                : undefined
            }
          />

          <Bucket
            label="Centralized"
            total={centralized.totalCount}
            unit="URLs"
            // Centralized doesn't get probed (yet); leave the bar empty
            // and let topHosts carry the signal.
            retrievable={0}
            denominator={0}
            details={[]}
            hint={
              centralized.topHosts.length > 0
                ? `Top hosts: ${centralized.topHosts
                    .map((h) => `${h.host} (${h.count})`)
                    .join(", ")}`
                : undefined
            }
            tone="warn"
          />
        </div>
      )}

      {entry.whatWouldHelp && (
        <p className="text-xs text-gray-400 italic">{entry.whatWouldHelp}</p>
      )}
    </div>
  )
}

type Detail = {
  label: string
  count: number
  tone: "good" | "warn" | "muted"
}

function Bucket({
  label,
  total,
  unit,
  retrievable,
  denominator,
  details,
  hint,
  tone,
}: {
  label: string
  total: number
  unit: string
  retrievable: number
  denominator: number
  details: Detail[]
  hint?: string
  tone?: "good" | "warn" | "muted"
}) {
  const pct =
    denominator > 0
      ? Math.round((retrievable / denominator) * 100)
      : null
  // The bar color: green if anything retrievable, gray otherwise. The
  // "warn" tone (used for the centralized bucket) flips the empty bar
  // to amber so the unprobed bucket reads as a soft risk signal.
  const fillClass =
    pct !== null && pct > 0
      ? "bg-emerald-500"
      : tone === "warn"
        ? "bg-amber-300"
        : "bg-gray-300"

  return (
    <div className="rounded border border-gray-100 bg-gray-50/40 p-3 space-y-2">
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-[11px] font-mono uppercase tracking-wider text-gray-500">
          {label}
        </span>
        <span className="text-xs text-gray-600">
          {total === 0 ? (
            "—"
          ) : (
            <>
              <span className="font-medium text-gray-900">{total}</span>{" "}
              {unit}
            </>
          )}
        </span>
      </div>

      {total > 0 && (
        <>
          <div className="h-1.5 rounded-full bg-gray-200 overflow-hidden">
            <div
              className={`h-full ${fillClass} transition-all`}
              style={{
                width:
                  pct === null
                    ? tone === "warn"
                      ? "100%"
                      : "0%"
                    : `${pct}%`,
              }}
            />
          </div>

          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px]">
            {pct !== null && (
              <span className="text-gray-600">
                <span className="font-medium text-gray-900">
                  {retrievable}/{denominator}
                </span>{" "}
                retrievable
              </span>
            )}
            {details.map((d) => (
              <span
                key={d.label}
                className={
                  d.tone === "good"
                    ? "text-emerald-700"
                    : d.tone === "warn"
                      ? "text-amber-700"
                      : "text-gray-500"
                }
              >
                <span className="font-medium">{d.count}</span> {d.label}
              </span>
            ))}
          </div>
        </>
      )}

      {hint && (
        <p className="text-[11px] text-gray-500 leading-relaxed">{hint}</p>
      )}
    </div>
  )
}
