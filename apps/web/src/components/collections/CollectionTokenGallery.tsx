import Link from "next/link"
import type { Address } from "viem"
import { OptimizedImage } from "@/components/OptimizedImage"
import { GalleryOwnerFilter } from "@/components/collections/GalleryOwnerFilter"
import { shortAddress } from "@/lib/collection"
import type { CollectionTokenRow } from "@/lib/indexer-queries"

/**
 * The generic token gallery grid: a paginated, thumbnail-cheap view of every
 * live token in a Surface collection, each cell linking to the token page.
 * Presentational only, no reads. Cells show the collection cover as the
 * thumbnail (a per-token capture ladder lands with the capture pipeline; until
 * then the cover is the degraded-but-correct source, per #269). Grids never
 * live-render iframes.
 *
 * The optional filter is "minted by", not "owned by": Ponder does not index
 * post-mint Transfer for Surface collections, so the only per-token address we
 * have is the mint recipient. Labeled accordingly so it never overclaims.
 */
export function CollectionTokenGallery({
  collection,
  name,
  tokens,
  coverImage,
  total,
  page,
  totalPages,
  ownerLabel,
  unavailable,
}: {
  collection: Address
  name: string
  tokens: CollectionTokenRow[]
  coverImage: string
  total: number
  page: number
  totalPages: number
  /** The resolved minted-by filter address, or null when unfiltered. */
  ownerLabel: Address | null
  unavailable: boolean
}) {
  const basePath = `/collections/${collection}/gallery`
  const pageHref = (p: number) => {
    const params = new URLSearchParams()
    if (ownerLabel) params.set("owner", ownerLabel)
    if (p > 1) params.set("page", String(p))
    const qs = params.toString()
    return qs ? `${basePath}?${qs}` : basePath
  }
  const cover = coverImage

  return (
    <div className="mx-auto max-w-[1400px] px-6 py-10 lg:px-12 lg:py-14 space-y-8">
      <header className="space-y-4">
        <nav className="text-[10px] font-mono uppercase tracking-wider text-gray-400">
          <Link href={`/collections/${collection}`} className="hover:text-fg">
            ← {name}
          </Link>
        </nav>
        <div className="flex flex-wrap items-baseline justify-between gap-4">
          <h1 className="text-2xl font-medium tracking-tight sm:text-3xl">
            {ownerLabel ? "Tokens minted by" : "All tokens"}
          </h1>
          <p className="text-[10px] font-mono uppercase tracking-wider text-gray-400 tabular-nums">
            {total} {total === 1 ? "token" : "tokens"}
          </p>
        </div>
        <GalleryOwnerFilter collection={collection} activeOwner={ownerLabel} />
        {ownerLabel && (
          <p className="text-[10px] font-mono uppercase tracking-wider text-gray-400">
            Minted by {shortAddress(ownerLabel)} · minted-by is the recipient at
            mint, not the live owner
          </p>
        )}
      </header>

      {unavailable ? (
        <div className="rounded-lg border border-gray-200 bg-surface p-6 space-y-2">
          <h2 className="text-sm font-medium">Tokens temporarily unavailable</h2>
          <p className="text-sm text-fg-muted">Try again shortly.</p>
        </div>
      ) : tokens.length === 0 ? (
        <p className="text-sm text-fg-muted">
          {ownerLabel ? "No tokens minted by this address." : "No tokens yet."}
        </p>
      ) : (
        <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
          {tokens.map((t) => (
            <li key={t.tokenId}>
              <Link
                href={`/collections/${collection}/${t.tokenId}`}
                className="group block overflow-hidden rounded-lg border border-gray-200 bg-gray-100 dark:bg-bg"
              >
                <div className="aspect-square flex items-center justify-center overflow-hidden [&_img]:h-full [&_img]:w-full [&_img]:object-cover">
                  {cover ? (
                    <OptimizedImage src={cover} alt={`${name} #${t.tokenId}`} width={600} />
                  ) : (
                    <span className="text-[10px] font-mono uppercase tracking-wider text-gray-400">
                      #{t.tokenId}
                    </span>
                  )}
                </div>
                <p className="px-3 py-2 text-[10px] font-mono uppercase tracking-wider text-gray-500">
                  #{t.tokenId}
                </p>
              </Link>
            </li>
          ))}
        </ul>
      )}

      {totalPages > 1 && (
        <nav
          aria-label="Gallery pages"
          className="flex items-center justify-between pt-2 text-[10px] font-mono uppercase tracking-wider text-gray-400"
        >
          {page > 1 ? (
            <Link href={pageHref(page - 1)} className="hover:text-fg">
              Newer
            </Link>
          ) : (
            <span className="text-gray-300">Newer</span>
          )}
          <span className="tabular-nums text-gray-500">
            Page {page} of {totalPages}
          </span>
          {page < totalPages ? (
            <Link href={pageHref(page + 1)} className="hover:text-fg">
              Older
            </Link>
          ) : (
            <span className="text-gray-300">Older</span>
          )}
        </nav>
      )}
    </div>
  )
}
