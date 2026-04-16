import Link from "next/link"

type GalleryItem = {
  contract: string
  tokenId: string
  title: string
  imageUrl: string
  creator: string
}

const VIDEO_EXTENSIONS = [".mp4", ".mov", ".webm", ".ogv"]

function isVideoUrl(url: string): boolean {
  const path = url.split("?")[0].toLowerCase()
  return VIDEO_EXTENSIONS.some((ext) => path.endsWith(ext))
}

export function ArtistGallery({ items }: { items: GalleryItem[] }) {
  if (items.length === 0) {
    return (
      <div className="text-center py-16 text-gray-400">
        <p className="text-lg">No works found</p>
        <p className="text-sm mt-1">
          This artist hasn&apos;t minted any works on the Foundation shared
          contract yet.
        </p>
      </div>
    )
  }

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
      {items.map((item) => (
        <GalleryCard key={`${item.contract}:${item.tokenId}`} item={item} />
      ))}
    </div>
  )
}

function GalleryCard({ item }: { item: GalleryItem }) {
  const href = `/${item.contract}/${item.tokenId}`
  const isVideo = isVideoUrl(item.imageUrl)

  return (
    <Link
      href={href}
      className="group block border border-gray-200 transition-colors hover:border-gray-400"
    >
      <div className="relative overflow-hidden bg-gray-100 aspect-[4/5]">
        {isVideo ? (
          <video
            src={item.imageUrl}
            className="w-full h-full object-cover"
            muted
            playsInline
            preload="metadata"
          />
        ) : (
          <img
            src={item.imageUrl}
            alt={item.title}
            className="w-full h-full object-cover"
            loading="lazy"
          />
        )}
      </div>
      <div className="p-4">
        <p className="text-base font-medium leading-tight truncate">
          {item.title}
        </p>
      </div>
    </Link>
  )
}
