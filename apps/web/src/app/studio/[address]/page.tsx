import Link from "next/link"
import { notFound } from "next/navigation"
import { getCachedCatalog } from "@/lib/catalog-cache"
import { studioTools, studioToolHref } from "@/lib/studio-tools"
import { StudioActionQueue } from "@/components/studio/StudioActionQueue"

/**
 * Studio overview: an action queue of things needing attention, then
 * one card per tool from the registry.
 *
 * Server data here must stay cheap and pg-backed (the catalog counts
 * ride the same `getCachedCatalog` entry the public record uses).
 * Owner-only live state belongs in StudioActionQueue's documented RPC
 * budget, not in this server component.
 */

type Params = Promise<{ address: string }>

const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/

export default async function StudioOverviewPage({
  params,
}: {
  params: Params
}) {
  const { address: raw } = await params
  const address = decodeURIComponent(raw).toLowerCase()
  // The layout normalizes ENS slugs to the canonical 0x URL before
  // children render; this guard only trips on unresolvable input.
  if (!ADDRESS_RE.test(address)) notFound()

  const record = await getCachedCatalog(address)
  const catalogCount =
    record.contracts.length + record.tokens.length + record.tokenRanges.length

  const subtitles: Record<string, string | null> = {
    catalog:
      catalogCount > 0
        ? `${catalogCount} ${catalogCount === 1 ? "entry" : "entries"} declared`
        : "Nothing declared yet",
  }

  return (
    <div className="space-y-8">
      <StudioActionQueue address={address} />

      <section className="space-y-3">
        <h2 className="text-[11px] font-mono font-medium uppercase tracking-wider text-gray-500">
          Tools
        </h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {studioTools().map((tool) => (
            <Link
              key={tool.id}
              href={studioToolHref(address, tool.id)}
              className="group border border-gray-200 rounded-md p-4 space-y-1.5 hover:border-gray-400 transition-colors"
            >
              <p className="text-sm font-medium group-hover:underline underline-offset-4">
                {tool.label} →
              </p>
              <p className="text-sm text-gray-500 leading-relaxed">
                {tool.description}
              </p>
              {subtitles[tool.id] && (
                <p className="text-[11px] font-mono text-gray-400">
                  {subtitles[tool.id]}
                </p>
              )}
            </Link>
          ))}
        </div>
      </section>

      <section className="space-y-2 border-t border-gray-100 pt-6">
        <h2 className="text-[11px] font-mono font-medium uppercase tracking-wider text-gray-500">
          Also yours
        </h2>
        <p className="text-sm text-gray-500 leading-relaxed">
          <Link
            href="/preserve"
            className="underline underline-offset-4 hover:text-fg transition-colors"
          >
            Preserve your work
          </Link>{" "}
          — pin your media to your own IPFS storage so it outlives any
          platform. Works for any wallet, so it lives outside the studio.
        </p>
      </section>
    </div>
  )
}
