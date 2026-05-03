import Link from "next/link"
import type { Metadata } from "next"
import { notFound } from "next/navigation"
import { BidForm } from "@/components/BidForm"
import { BidHistory } from "@/components/BidHistory"
import { SettledSummary } from "@/components/SettledSummary"
import { getArtistHouse, getAuctionById, getBidHistory } from "@/lib/auctions"
import { getTokenMetadata } from "@/lib/metadata"
import { getArtistDisplayName } from "@/lib/artist"
import { getEnsNames } from "@/lib/ens"
import { formatAddress, formatEth } from "@/lib/format"


const VIDEO_EXTENSIONS = [".mp4", ".mov", ".webm", ".ogv"]

export const revalidate = 60

type Params = Promise<{ auctionId: string }>

export async function generateMetadata({
  params,
}: {
  params: Params
}): Promise<Metadata> {
  const { auctionId } = await params
  const name = await getArtistDisplayName()
  const auction = await getAuctionById(auctionId)
  if (!auction) {
    return { title: `Auction ${auctionId} | ${name}` }
  }
  const metadata = await getTokenMetadata(auction.tokenContract, auction.tokenId)
  const title = metadata?.name ?? `Auction #${auctionId}`
  const description =
    auction.status === "settled" && auction.finalPrice
      ? `Sold for ${formatEth(auction.finalPrice)} ETH on ${name}'s on-chain auction page.`
      : auction.amount !== "0"
        ? `Currently ${formatEth(auction.amount)} ETH. Bid live on ${name}'s auction page.`
        : `Reserve ${formatEth(auction.reservePrice)} ETH. Bid live on ${name}'s auction page.`
  return {
    title,
    description,
    openGraph: { title, description },
    twitter: { card: "summary_large_image", title, description },
  }
}

export default async function AuctionPage({ params }: { params: Params }) {
  const { auctionId } = await params
  const [house, auction] = await Promise.all([
    getArtistHouse(),
    getAuctionById(auctionId),
  ])
  if (!house || !auction) notFound()

  const [metadata, bids] = await Promise.all([
    getTokenMetadata(auction.tokenContract, auction.tokenId),
    getBidHistory(auctionId),
  ])

  // Single batched ENS resolve for every address shown on this page.
  const addressesToResolve: string[] = []
  for (const b of bids) addressesToResolve.push(b.bidder)
  if (auction.winner) addressesToResolve.push(auction.winner)
  if (auction.bidder) addressesToResolve.push(auction.bidder)
  const ensMap = await getEnsNames(addressesToResolve)

  const title = metadata?.name ?? `#${auction.tokenId}`
  const image = metadata?.image ?? null
  const isVideo = image
    ? VIDEO_EXTENSIONS.some((ext) =>
        image.split("?")[0].toLowerCase().endsWith(ext),
      )
    : false
  const isHistorical =
    auction.status === "settled" || auction.status === "cancelled"
  const settledAtTime = bids.length > 0 ? bids[0].blockTime : null

  return (
    <div className="mx-auto max-w-[2000px] px-6 py-12">
      <Link
        href="/"
        className="mb-8 inline-flex items-center gap-1 text-xs font-mono uppercase tracking-wider text-gray-500 hover:text-fg transition-colors"
      >
        ← All auctions
      </Link>

      <div className="grid gap-10 lg:grid-cols-[1.5fr_1fr]">
        {/* Media */}
        <div className="relative aspect-square w-full overflow-hidden bg-gray-100 border border-gray-200">
          {image && isVideo ? (
            // eslint-disable-next-line jsx-a11y/media-has-caption
            <video
              src={image}
              autoPlay
              muted
              loop
              playsInline
              className="h-full w-full object-contain"
            />
          ) : image ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={image}
              alt={title}
              className="h-full w-full object-contain"
            />
          ) : (
            <div className="flex h-full items-center justify-center text-[11px] font-mono uppercase tracking-wider text-gray-400">
              No preview
            </div>
          )}
        </div>

        {/* Right column: title, panel, history, links */}
        <div className="flex flex-col gap-6 min-w-0">
          <div>
            <h1 className="text-3xl font-semibold tracking-tight">{title}</h1>
            {metadata?.description ? (
              <p className="mt-3 max-w-prose text-sm text-fg-muted whitespace-pre-line">
                {metadata.description}
              </p>
            ) : null}
          </div>

          {isHistorical ? (
            <SettledSummary
              auction={auction}
              bids={bids}
              ensMap={ensMap}
              settledAtTime={settledAtTime}
            />
          ) : (
            <>
              <BidForm
                houseAddress={house}
                auctionId={auction.auctionId}
                ensMap={ensMap}
                initial={{
                  amount: auction.amount,
                  endTime: auction.endTime,
                  reservePrice: auction.reservePrice,
                  bidder: auction.bidder,
                  firstBidTime: auction.firstBidTime,
                  tokenOwner: auction.tokenOwner,
                }}
              />
              {bids.length > 0 ? (
                <section className="space-y-3">
                  <p className="text-[10px] font-mono uppercase tracking-wider text-gray-400">
                    Bid history
                  </p>
                  <BidHistory bids={bids} ensMap={ensMap} />
                </section>
              ) : null}
            </>
          )}

          <section className="text-[11px] font-mono text-gray-400 pt-2 border-t border-gray-100">
            <p className="pt-3 space-x-4">
              <a
                href={`https://etherscan.io/address/${auction.tokenContract}`}
                target="_blank"
                rel="noreferrer"
                className="hover:text-fg transition-colors"
              >
                Token {formatAddress(auction.tokenContract)} ↗
              </a>
              <a
                href={`https://etherscan.io/address/${house}`}
                target="_blank"
                rel="noreferrer"
                className="hover:text-fg transition-colors"
              >
                House {formatAddress(house)} ↗
              </a>
            </p>
          </section>
        </div>
      </div>
    </div>
  )
}
