import Link from "next/link"
import { formatEther } from "viem"
import type { GalleryItem } from "@/lib/artist-queries"
import type { ProfileOpenRelease } from "@/lib/profile-queries"

export function ProfileAvailable({
  releases,
  items,
  listingTotal,
}: {
  releases: ProfileOpenRelease[]
  items: GalleryItem[]
  listingTotal: number
}) {
  const available = items.filter((item) =>
    item.availability && item.availability.status !== "settling",
  )
  if (listingTotal === 0 && releases.length === 0) return null

  return (
    <section id="available" className="scroll-mt-20 space-y-4">
      <SectionHeading
        title="Available now"
        detail="Open artist-owned PND releases are shown separately from listings and auctions of already-minted work. Every action is verified by its contract at transaction time."
      />
      {releases.length > 0 && (
        <div className="space-y-2">
          <p className="font-mono text-[10px] uppercase tracking-wide text-gray-500">
            Open releases
          </p>
          <div className="divide-y divide-gray-200 border-y border-gray-200">
            {releases.map((release) => (
              <Link
                key={release.collection}
                href={`/collections/${release.collection}`}
                className="grid gap-1 py-3 hover:bg-gray-50 sm:grid-cols-[1fr_auto] sm:items-center sm:px-2"
              >
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{release.name}</p>
                  <p className="font-mono text-[10px] text-gray-500">
                    PND Surface · primary release
                    {release.supplyCap !== "0"
                      ? ` · ${release.minted}/${release.supplyCap} minted`
                      : ` · ${release.minted} minted`}
                  </p>
                </div>
                <p className="font-mono text-xs">
                  {releasePrice(release)} <span aria-hidden>→</span>
                </p>
              </Link>
            ))}
          </div>
        </div>
      )}
      {listingTotal > 0 && (
        <div className="space-y-2">
          <p className="font-mono text-[10px] uppercase tracking-wide text-gray-500">
            Listed works
          </p>
          <div className="divide-y divide-gray-200 border-y border-gray-200">
            {available.map((item) => {
              const state = item.availability!
              return (
                <Link
                  key={`${item.contract}:${item.tokenId}`}
                  href={`/${item.contract}/${item.tokenId}`}
                  className="grid gap-1 py-3 hover:bg-gray-50 sm:grid-cols-[1fr_auto] sm:items-center sm:px-2"
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">{item.title}</p>
                    <p className="font-mono text-[10px] text-gray-500">
                      {state.source} · {state.kind} · {state.freshness}
                      {state.observedAt ? ` · observed ${formatObserved(state.observedAt)}` : ""}
                    </p>
                  </div>
                  <p className="font-mono text-xs">
                    {formatEther(BigInt(state.price))} ETH <span aria-hidden>→</span>
                  </p>
                </Link>
              )
            })}
          </div>
        </div>
      )}
      {available.length < listingTotal && (
        <p className="text-xs text-amber-700">
          Showing {available.length} of {listingTotal} listed works while more results load. The Created record below remains availability-ranked.
        </p>
      )}
    </section>
  )
}

function releasePrice(release: ProfileOpenRelease): string {
  if (release.dynamicPrice) return "Onchain quote"
  if (release.price === "0") return "Free mint"
  return `${formatEther(BigInt(release.price))} ETH`
}

export function SectionHeading({ title, detail }: { title: string; detail: string }) {
  return (
    <div className="max-w-3xl space-y-1">
      <h2 className="text-lg font-semibold">{title}</h2>
      <p className="text-xs leading-relaxed text-gray-500">{detail}</p>
    </div>
  )
}

function formatObserved(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return "time unavailable"
  return date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })
}
