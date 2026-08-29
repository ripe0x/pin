import Link from "next/link"
import type { GalleryPage } from "@/lib/artist-queries"
import { ArtistGallery } from "@/components/artist/ArtistGallery"
import { SectionHeading } from "./ProfileAvailable"

export function ProfileCreatedRecord({
  address,
  page,
}: {
  address: string
  page: GalleryPage
}) {
  if (page.total === 0) return null
  const pageCount = Math.max(1, Math.ceil(page.total / page.pageSize))
  const current = page.page + 1
  // Profile pagination is server-driven so every page stays on the explicit
  // Postgres-only enrichment path. ArtistGallery receives a closed page and
  // therefore never invokes its legacy artist API from this route.
  const closedPage = { ...page, hasMore: false }

  return (
    <section id="created" className="scroll-mt-20 space-y-5">
      <SectionHeading
        title="Created record"
        detail="Works attributed to this address by indexed platform mint evidence. Catalog declarations are shown separately; current ownership does not change creator attribution."
      />
      <ArtistGallery artistAddress={address} initialPage={closedPage} />
      {pageCount > 1 && (
        <nav aria-label="Created work pages" className="flex items-center justify-center gap-4 font-mono text-[11px]">
          {current > 1 ? (
            <Link href={`/profile/${address}?createdPage=${current - 1}#created`} className="hover:underline">
              ← Newer
            </Link>
          ) : <span className="text-gray-300">← Newer</span>}
          <span className="text-gray-500">Page {current} of {pageCount}</span>
          {current < pageCount ? (
            <Link href={`/profile/${address}?createdPage=${current + 1}#created`} className="hover:underline">
              Older →
            </Link>
          ) : <span className="text-gray-300">Older →</span>}
        </nav>
      )}
    </section>
  )
}
