/**
 * First-class, always-visible attribute traits for a token, parsed from the
 * contract's tokenURI metadata. Distinct from the raw/JSON metadata, which
 * lives in the tertiary slide-out (MetadataDrawer). Renders nothing when the
 * token has no attributes.
 */

type Attr = { trait_type?: string; value?: unknown; display_type?: string }

function formatVal(v: unknown): string {
  if (v === null || v === undefined) return "—"
  if (typeof v === "object") {
    try {
      return JSON.stringify(v)
    } catch {
      return String(v)
    }
  }
  return String(v)
}

export function TokenAttributes({ metadata }: { metadata: Record<string, unknown> | null }) {
  const attributes = Array.isArray(metadata?.attributes) ? (metadata.attributes as Attr[]) : []
  if (attributes.length === 0) return null

  return (
    <section className="py-5 border-b border-gray-100">
      <h2 className="text-[10px] font-mono uppercase tracking-wider text-gray-400 mb-3">Attributes</h2>
      <div className="grid grid-cols-2 gap-2">
        {attributes.map((a, i) => (
          <div key={i} className="rounded border border-gray-200 px-3 py-2">
            <div
              className="text-[9px] font-mono uppercase tracking-wider text-gray-400 truncate"
              title={a.trait_type ?? undefined}
            >
              {a.trait_type ?? "—"}
            </div>
            <div className="text-[11px] font-mono text-fg break-words tabular-nums">
              {formatVal(a.value)}
            </div>
          </div>
        ))}
      </div>
    </section>
  )
}
