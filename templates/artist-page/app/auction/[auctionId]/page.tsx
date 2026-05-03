import Image from "next/image"
import Link from "next/link"
import type { Metadata } from "next"
import { notFound } from "next/navigation"
import { ArtistHeader } from "@/components/ArtistHeader"
import { BidForm } from "@/components/BidForm"
import { BidHistory } from "@/components/BidHistory"
import { getArtistHouse, getAuctionById, getBidHistory } from "@/lib/auctions"
import { getTokenMetadata } from "@/lib/metadata"
import { getArtistDisplayName } from "@/lib/artist"
import { displayFor, getEnsNames } from "@/lib/ens"
import { formatAddress, formatEth } from "@/lib/format"

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
    return { title: `Auction ${auctionId} — ${name}` }
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

  // ENS-resolve every address shown on this page in one batched lookup —
  // bidders, the winner, and the active bidder. The map is shared with
  // the bid-history table so we don't duplicate RPC calls.
  const addressesToResolve: string[] = []
  for (const b of bids) addressesToResolve.push(b.bidder)
  if (auction.winner) addressesToResolve.push(auction.winner)
  if (auction.bidder) addressesToResolve.push(auction.bidder)
  const ensMap = await getEnsNames(addressesToResolve)

  const title = metadata?.name ?? `Token #${auction.tokenId}`
  const image = metadata?.image ?? null

  return (
    <div className="min-h-screen">
      <ArtistHeader />
      <main className="mx-auto max-w-5xl px-6 py-10">
        <Link
          href="/"
          className="mb-6 inline-flex items-center gap-1 text-sm text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--foreground))]"
        >
          ← All auctions
        </Link>
        <div className="grid gap-10 lg:grid-cols-2">
          <div className="relative aspect-square w-full overflow-hidden bg-[hsl(var(--muted))]">
            {image ? (
              <Image
                src={image}
                alt={title}
                fill
                sizes="(max-width: 1024px) 100vw, 50vw"
                className="object-contain"
                unoptimized
                priority
              />
            ) : (
              <div className="flex h-full items-center justify-center text-sm text-[hsl(var(--muted-foreground))]">
                No preview
              </div>
            )}
          </div>
          <div className="flex flex-col gap-6">
            <div>
              <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">
                {title}
              </h1>
              {metadata?.description ? (
                <p className="mt-3 max-w-prose text-sm text-[hsl(var(--muted-foreground))]">
                  {metadata.description}
                </p>
              ) : null}
            </div>

            {auction.status === "settled" || auction.status === "cancelled" ? (
              <HistoricalSummary
                status={auction.status}
                finalPrice={auction.finalPrice}
                winner={auction.winner}
                winnerDisplay={
                  auction.winner ? displayFor(auction.winner, ensMap) : undefined
                }
              />
            ) : (
              <BidForm
                houseAddress={house}
                auctionId={auction.auctionId}
                initial={{
                  amount: auction.amount,
                  endTime: auction.endTime,
                  reservePrice: auction.reservePrice,
                  bidder: auction.bidder,
                  firstBidTime: auction.firstBidTime,
                  tokenOwner: auction.tokenOwner,
                }}
              />
            )}

            <section>
              <h2 className="mb-3 text-sm font-medium uppercase tracking-wider text-[hsl(var(--muted-foreground))]">
                Bid history
              </h2>
              <BidHistory bids={bids} ensMap={ensMap} />
            </section>

            <section className="text-xs text-[hsl(var(--muted-foreground))]">
              <p>
                Token contract:{" "}
                <a
                  href={`https://etherscan.io/address/${auction.tokenContract}`}
                  target="_blank"
                  rel="noreferrer"
                  className="font-mono hover:underline"
                >
                  {formatAddress(auction.tokenContract)}
                </a>
                {" · "}
                Auction house:{" "}
                <a
                  href={`https://etherscan.io/address/${house}`}
                  target="_blank"
                  rel="noreferrer"
                  className="font-mono hover:underline"
                >
                  {formatAddress(house)}
                </a>
              </p>
            </section>
          </div>
        </div>
      </main>
    </div>
  )
}

function HistoricalSummary({
  status,
  finalPrice,
  winner,
  winnerDisplay,
}: {
  status: "settled" | "cancelled"
  finalPrice?: string
  winner?: string
  winnerDisplay?: string
}) {
  if (status === "cancelled") {
    return (
      <div className="border border-[hsl(var(--border))] bg-[hsl(var(--muted))] p-5">
        <p className="text-sm text-[hsl(var(--muted-foreground))]">
          This auction was cancelled.
        </p>
      </div>
    )
  }
  return (
    <div className="border border-[hsl(var(--border))] bg-[hsl(var(--muted))] p-5">
      <p className="text-sm text-[hsl(var(--muted-foreground))]">Sold for</p>
      <p className="mt-1 font-mono text-2xl font-semibold">
        {finalPrice ? formatEth(finalPrice) : "—"} ETH
      </p>
      {winner ? (
        <p className="mt-2 text-sm text-[hsl(var(--muted-foreground))]">
          Winner:{" "}
          <a
            href={`https://etherscan.io/address/${winner}`}
            target="_blank"
            rel="noreferrer"
            className="hover:underline"
          >
            {winnerDisplay ?? formatAddress(winner)}
          </a>
        </p>
      ) : null}
    </div>
  )
}
