import Link from "next/link"
import type { Address } from "viem"
import { OptimizedImage } from "@/components/OptimizedImage"
import type { RenderRouterBatch } from "@/lib/collection-onchain"

/**
 * Batch view: one card per IBatchRenderRouter batch, shown instead of the
 * default token grid when the collection's renderer advertises the
 * interface (see isBatchRenderRouter). Each card is the batch's shared
 * artwork (rendered from its startId token) plus its label and id range;
 * the card links to the batch's own filtered token list.
 */
export function BatchGrid({
  collection,
  batches,
  images,
}: {
  collection: Address
  batches: RenderRouterBatch[]
  /** batch index -> image src, resolved via getCollectionToken(startId) by
   *  the page (a server read, so this component stays presentational). */
  images: Record<number, string>
}) {
  if (batches.length === 0) return null
  return (
    <div className="border-y border-gray-200 bg-gray-100 dark:bg-bg">
      <div className="mx-auto grid max-w-[1400px] grid-cols-2 gap-px bg-gray-200 sm:grid-cols-3 lg:grid-cols-4 dark:bg-gray-800">
        {batches.map((b) => {
          const count = Number(b.endId - b.startId) + 1
          const image = images[b.index]
          return (
            <Link
              key={b.index}
              href={`/collections/${collection}/batch/${b.index}`}
              className="group relative flex aspect-square flex-col justify-end overflow-hidden bg-surface"
            >
              {image ? (
                <OptimizedImage
                  src={image}
                  alt={b.label || `Batch ${b.index + 1}`}
                  width={600}
                  className="absolute inset-0 h-full w-full object-cover transition-opacity group-hover:opacity-80"
                />
              ) : (
                <div className="absolute inset-0 flex items-center justify-center">
                  <p className="text-[10px] font-mono uppercase tracking-wider text-gray-400">
                    No artwork yet
                  </p>
                </div>
              )}
              <div className="relative z-10 bg-gradient-to-t from-black/70 to-transparent px-3 py-2">
                <p className="truncate text-xs font-medium text-white">
                  {b.label || `Batch ${b.index + 1}`}
                </p>
                <p className="text-[10px] font-mono text-gray-200">
                  #{b.startId.toString()}–{b.endId.toString()} · {count} token{count === 1 ? "" : "s"}
                </p>
              </div>
            </Link>
          )
        })}
      </div>
    </div>
  )
}
