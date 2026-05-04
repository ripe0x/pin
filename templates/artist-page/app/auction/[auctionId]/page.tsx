import type { Metadata } from "next"
import { notFound } from "next/navigation"
import { BidForm } from "@/components/BidForm"
import { BidHistory } from "@/components/BidHistory"
import { SettledSummary } from "@/components/SettledSummary"
import { TokenMedia } from "@/components/TokenMedia"
import { Provenance } from "@/components/Provenance"
import { getArtistHouse, getAuctionById, getBidHistory } from "@/lib/auctions"
import { getTokenMetadata } from "@/lib/metadata"
import { getTokenOwner, getTokenProvenance } from "@/lib/token"
import { getArtistDisplayName } from "@/lib/artist"
import { getEnsNames } from "@/lib/ens"
import { displayFor, formatAddress, formatEth } from "@/lib/format"
import { explorerAddressUrl } from "@/lib/explorer"
import { getConfig } from "@/lib/config"

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
  const cfg = getConfig()
  const [house, auction, displayName] = await Promise.all([
    getArtistHouse(),
    getAuctionById(auctionId),
    getArtistDisplayName(),
  ])
  if (!house || !auction) notFound()

  // Fetch all the per-page data in parallel — token metadata, bid history,
  // current owner, and provenance timeline. Each is independently cached
  // via unstable_cache so re-renders are cheap.
  const [metadata, bids, currentOwner, provenance] = await Promise.all([
    getTokenMetadata(auction.tokenContract, auction.tokenId),
    getBidHistory(auctionId),
    getTokenOwner(auction.tokenContract, auction.tokenId),
    getTokenProvenance(auction.tokenContract, auction.tokenId, house),
  ])

  // Single batched ENS resolve covering every address shown on this page —
  // bidders, winner, current bidder, current owner, and every from/to
  // pair in the provenance timeline.
  const addressesToResolve: string[] = []
  for (const b of bids) addressesToResolve.push(b.bidder)
  if (auction.winner) addressesToResolve.push(auction.winner)
  if (auction.bidder) addressesToResolve.push(auction.bidder)
  if (currentOwner) addressesToResolve.push(currentOwner)
  for (const p of provenance) {
    addressesToResolve.push(p.from)
    if (p.to) addressesToResolve.push(p.to)
  }
  const ensMap = await getEnsNames(addressesToResolve)

  const title = metadata?.name ?? `#${auction.tokenId}`
  const image = metadata?.image ?? null
  const isHistorical =
    auction.status === "settled" || auction.status === "cancelled"
  const settledAtTime = bids.length > 0 ? bids[0].blockTime : null
  // Caps display name for the creator caption — mirrors PND's mono-caps treatment.
  const creatorCaption = displayName.toUpperCase()

  return (
    <div className="mx-auto max-w-[2000px]">
      {/* Two-column desktop layout matching PND's token page:
          left column is sticky-pinned artwork, right column scrolls. */}
      <div className="grid grid-cols-1 lg:grid-cols-[2fr_1fr] min-h-[calc(100vh-64px)]">
        <div className="lg:sticky lg:top-16 lg:h-[calc(100vh-64px)] flex items-center justify-center bg-gray-100 dark:bg-bg p-8 lg:p-12">
          <TokenMedia src={image} title={title} />
        </div>

        <aside className="lg:border-l border-gray-200 dark:bg-gray-100 px-6 py-8 lg:px-8 lg:py-10">
          {/* Title + creator caption */}
          <section className="pb-5 border-b border-gray-100 space-y-2">
            <a
              href={explorerAddressUrl(cfg.artistAddress)}
              target="_blank"
              rel="noreferrer"
              className="block text-[11px] font-mono uppercase tracking-wider text-gray-600 hover:text-fg transition-colors"
            >
              {creatorCaption}
            </a>
            <h1 className="text-base font-mono font-medium tracking-tight">
              {title}
            </h1>
          </section>

          {/* Description — the only prose section, in sans (Switzer). */}
          {metadata?.description ? (
            <section className="py-5 border-b border-gray-100">
              <p className="text-sm text-gray-600 leading-relaxed whitespace-pre-line">
                {metadata.description}
              </p>
            </section>
          ) : null}

          {/* Auction state — settled summary or live bid panel. */}
          {isHistorical ? (
            <section className="py-5 border-b border-gray-100">
              <SettledSummary
                auction={auction}
                bids={bids}
                ensMap={ensMap}
                settledAtTime={settledAtTime}
              />
            </section>
          ) : (
            <>
              <section className="py-5 border-b border-gray-100">
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
              </section>
              {bids.length > 0 ? (
                <section className="py-5 border-b border-gray-100 space-y-3">
                  <p className="text-[10px] font-mono uppercase tracking-wider text-gray-400">
                    Bid history
                  </p>
                  <BidHistory bids={bids} ensMap={ensMap} />
                </section>
              ) : null}
            </>
          )}

          {/* Owner — current ownerOf the NFT. When the token is escrowed
              in the artist's auction house we relabel + reword so it's
              clear it's not actually held by some random contract address. */}
          {currentOwner ? (
            <section className="py-5 border-b border-gray-100 space-y-1">
              {currentOwner.toLowerCase() === house.toLowerCase() ? (
                <>
                  <p className="text-[10px] font-mono uppercase tracking-wider text-gray-400">
                    Held in escrow
                  </p>
                  <p className="text-xs">
                    <span>{displayName}&rsquo;s </span>
                    <a
                      href={explorerAddressUrl(currentOwner)}
                      target="_blank"
                      rel="noreferrer"
                      className="hover:underline"
                    >
                      auction contract
                    </a>
                  </p>
                </>
              ) : (
                <>
                  <p className="text-[10px] font-mono uppercase tracking-wider text-gray-400">
                    Owner
                  </p>
                  <a
                    href={explorerAddressUrl(currentOwner)}
                    target="_blank"
                    rel="noreferrer"
                    className={`text-xs hover:underline ${
                      ensMap.has(currentOwner.toLowerCase())
                        ? ""
                        : "font-mono"
                    }`}
                  >
                    {displayFor(currentOwner, ensMap)}
                  </a>
                </>
              )}
            </section>
          ) : null}

          {/* Provenance — full transfer timeline (mint, lists, sales). */}
          {provenance.length > 0 ? (
            <section className="py-5 border-b border-gray-100">
              <Provenance entries={provenance} ensMap={ensMap} />
            </section>
          ) : null}

          {/* Contract — Address + Token ID rows, matching PND's token page. */}
          <section className="pt-5">
            <h3 className="text-[10px] font-mono font-medium uppercase tracking-wider text-gray-400 mb-3">
              Contract
            </h3>
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2">
              <dt className="text-[10px] font-mono uppercase tracking-wider text-gray-400">
                Address
              </dt>
              <dd className="text-[10px] font-mono truncate">
                <a
                  href={explorerAddressUrl(auction.tokenContract)}
                  target="_blank"
                  rel="noreferrer"
                  className="hover:underline"
                >
                  {auction.tokenContract}
                </a>
              </dd>
              <dt className="text-[10px] font-mono uppercase tracking-wider text-gray-400">
                Token ID
              </dt>
              <dd className="text-[10px] font-mono">{auction.tokenId}</dd>
              <dt className="text-[10px] font-mono uppercase tracking-wider text-gray-400">
                House
              </dt>
              <dd className="text-[10px] font-mono truncate">
                <a
                  href={explorerAddressUrl(house)}
                  target="_blank"
                  rel="noreferrer"
                  className="hover:underline"
                >
                  {formatAddress(house)} ↗
                </a>
              </dd>
            </dl>
          </section>
        </aside>
      </div>
    </div>
  )
}
