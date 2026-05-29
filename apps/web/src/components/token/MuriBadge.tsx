import type { MuriTokenOverlay } from "@/lib/reads"

function truncateHash(hash: string): string {
  const h = hash.startsWith("0x") ? hash.slice(2) : hash
  if (h.length <= 12) return `0x${h}`
  return `0x${h.slice(0, 8)}…${h.slice(-6)}`
}

/**
 * Token-page section: surfaces a token's MURI onchain preservation state
 * (fallback URI count + integrity hash). Reads come from Postgres
 * (muri_tokens) — no live RPC. Render only when the overlay is non-null.
 */
export function MuriPreservationSection({
  overlay,
}: {
  overlay: MuriTokenOverlay
}) {
  const fallbacks = overlay.artistUriCount + overlay.collectorUriCount
  return (
    <section className="pt-5">
      <h3 className="text-[10px] font-mono font-medium uppercase tracking-wider text-gray-400 mb-3">
        Preservation
      </h3>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2">
        <dt className="text-[10px] font-mono uppercase tracking-wider text-gray-400">
          Onchain
        </dt>
        <dd className="text-[10px] font-mono">
          MURI · {fallbacks} fallback{fallbacks === 1 ? "" : "s"}
        </dd>
        {overlay.fileHash && (
          <>
            <dt className="text-[10px] font-mono uppercase tracking-wider text-gray-400">
              File hash
            </dt>
            <dd
              className="text-[10px] font-mono"
              title={`SHA-256 integrity hash: ${overlay.fileHash}`}
            >
              {truncateHash(overlay.fileHash)}
            </dd>
          </>
        )}
      </dl>
      <p className="mt-3 text-[10px] leading-relaxed text-gray-400">
        This artwork keeps {fallbacks} fallback link{fallbacks === 1 ? "" : "s"}{" "}
        and a SHA-256 integrity hash onchain via the MURI protocol, so it stays
        verifiable even if a source goes offline.
      </p>
    </section>
  )
}

/**
 * Compact gallery-tile indicator. Shown on tiles whose token is registered
 * with MURI. `uriCount` is the artist URI count (null when not preserved).
 */
export function MuriTileBadge({ uriCount }: { uriCount: number | null }) {
  if (uriCount == null) return null
  return (
    <span
      className="inline-flex items-center gap-1 rounded-full bg-black/70 px-1.5 py-0.5 text-[9px] font-mono uppercase tracking-wider text-white backdrop-blur"
      title={`Preserved onchain via MURI · ${uriCount} fallback${uriCount === 1 ? "" : "s"}`}
    >
      <svg
        viewBox="0 0 24 24"
        width="9"
        height="9"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
      </svg>
      MURI
    </span>
  )
}
