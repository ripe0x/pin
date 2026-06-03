import type { Metadata } from "next"
import { notFound } from "next/navigation"
import { cache } from "react"
import Link from "next/link"
import { ipfsToHttp } from "@pin/shared"
import { AuctionPanel } from "@/components/auction/AuctionPanel"
import { SettledAuctionSummary } from "@/components/auction/SettledAuctionSummary"
import { TokenMedia } from "@/components/token/TokenMedia"
import { getAuctionDetail } from "@/lib/auctions"
import { resolveTokenMetadataDirect } from "@/lib/onchain-discovery"
import { formatEthAmount } from "@/lib/format-eth"
import { isCrawler } from "@/lib/crawler"

export const revalidate = 60

type Params = Promise<{ house: string; auctionId: string }>

// Request-scoped memo: `generateMetadata` and the page body both call this, so
// one request resolves the auction + metadata once. `cache()` is React's
// built-in per-request dedup — no cross-request leakage.
const getAuctionPageData = cache(async (house: string, auctionId: string) => {
  const detail = await getAuctionDetail(house, auctionId).catch(() => null)
  if (!detail) return null
  const meta = await resolveTokenMetadataDirect(
    detail.nftContract,
    detail.tokenId,
  ).catch(() => null)
  return { detail, meta }
})

function shortDescription(
  detail: NonNullable<Awaited<ReturnType<typeof getAuctionPageData>>>["detail"],
): string {
  if (detail.status === "settled" && detail.finalPriceWei != null) {
    return `Sold for ${formatEthAmount(detail.finalPriceWei)} ETH`
  }
  if (detail.status === "active" && detail.live) {
    return detail.live.awaitingFirstBid
      ? `Reserve ${formatEthAmount(detail.live.amount)} ETH — bid live.`
      : `Currently ${formatEthAmount(detail.live.amount)} ETH — bid live.`
  }
  return "Auction cancelled."
}

export async function generateMetadata({
  params,
}: {
  params: Params
}): Promise<Metadata> {
  const { house, auctionId } = await params
  const data = await getAuctionPageData(house, auctionId)
  if (!data) return { title: "Auction not found" }

  const tokenName = data.meta?.name ?? `#${data.detail.tokenId}`
  const ogTitle = `${tokenName} · ${shortDescription(data.detail)}`
  const description = shortDescription(data.detail)
  const image = data.meta?.image ? ipfsToHttp(data.meta.image) : undefined
  return {
    // Bare token name — the root layout's `%s | PND` template adds the suffix.
    title: tokenName,
    description,
    openGraph: {
      title: ogTitle,
      description,
      images: image ? [image] : undefined,
    },
    twitter: {
      card: "summary_large_image",
      title: ogTitle,
      description,
      images: image ? [image] : undefined,
    },
  }
}

export default async function AuctionPage({ params }: { params: Params }) {
  const { house, auctionId } = await params

  // Crawlers only need OG metadata (already produced by generateMetadata).
  // Short-circuit so unfurl bursts don't fan out to the bid-history / ENS
  // reads the body performs.
  if (await isCrawler()) {
    return (
      <div className="mx-auto max-w-[2000px] px-6 py-12">
        <p className="text-sm text-gray-500">Loading auction…</p>
      </div>
    )
  }

  const data = await getAuctionPageData(house, auctionId)
  if (!data) notFound()

  const { detail, meta } = data
  const imageUrl = meta?.image
    ? ipfsToHttp(meta.image)
    : "https://placehold.co/1200x1500/F2F2F2/999999?text=Artwork"
  const animationUrl = meta?.animation_url ? ipfsToHttp(meta.animation_url) : null
  const title = meta?.name ?? `#${detail.tokenId}`
  const tokenHref = `/${detail.nftContract}/${detail.tokenId}`
  const platformLabel =
    detail.source === "foundation"
      ? "Foundation"
      : `${detail.sellerDisplay}’s auction house`

  return (
    <div>
      <div className="grid grid-cols-1 lg:grid-cols-[2fr_1fr] min-h-[calc(100vh-64px)]">
        {/* Left: sticky artwork */}
        <div className="lg:sticky lg:top-16 lg:h-[calc(100vh-64px)] flex items-center justify-center bg-gray-100 dark:bg-bg p-8 lg:p-12">
          <TokenMedia imageUrl={imageUrl} animationUrl={animationUrl} title={title} />
        </div>

        {/* Right: scrolling sidebar */}
        <aside className="lg:border-l border-gray-200 dark:bg-gray-100 px-6 py-8 lg:px-8 lg:py-10">
          {/* Title + seller + back-to-token */}
          <section className="pb-5 border-b border-gray-100 space-y-2">
            <Link
              href={`/artist/${detail.seller}`}
              className="inline-block text-[11px] font-mono uppercase tracking-wider text-gray-600 hover:text-fg transition-colors"
            >
              Auctioned by {detail.sellerDisplay}
            </Link>
            <h1 className="text-base font-mono font-medium tracking-tight">
              <Link href={tokenHref} className="hover:underline">
                {title}
              </Link>
            </h1>
            <p className="text-[11px] font-mono text-gray-400">via {platformLabel}</p>
          </section>

          {/* Auction state */}
          <section className="py-5 border-b border-gray-100">
            {detail.status === "active" && detail.live ? (
              <AuctionPanel auction={detail.live} />
            ) : detail.status === "settled" ? (
              <SettledAuctionSummary
                auction={{
                  seller: detail.seller,
                  sellerDisplay: detail.sellerDisplay,
                  winner: detail.winner ?? "",
                  winnerDisplay: detail.winnerDisplay,
                  amount: detail.finalPriceWei ?? 0n,
                  settledAtTime: detail.settledAtTime ?? 0,
                  bids: detail.bids,
                }}
              />
            ) : (
              <div className="rounded-lg border border-gray-200 bg-surface p-5 space-y-2">
                <div className="flex items-center gap-2">
                  <span className="inline-block h-1.5 w-1.5 rounded-full bg-gray-400" />
                  <span className="text-[10px] font-mono uppercase tracking-wider text-gray-500">
                    Auction cancelled
                  </span>
                </div>
                <p className="text-xs font-mono text-gray-500">
                  This auction was cancelled with no sale.
                </p>
              </div>
            )}
          </section>

          {/* Link back to the token's full history */}
          <section className="py-5 border-b border-gray-100">
            <Link
              href={tokenHref}
              className="text-xs font-mono text-gray-600 hover:text-fg hover:underline transition-colors"
            >
              ← View token &amp; full provenance
            </Link>
          </section>

          {/* Contract + auction identity */}
          <section className="pt-5">
            <h3 className="text-[10px] font-mono font-medium uppercase tracking-wider text-gray-400 mb-3">
              Auction
            </h3>
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2">
              <dt className="text-[10px] font-mono uppercase tracking-wider text-gray-400">
                Token
              </dt>
              <dd className="text-[10px] font-mono truncate">
                <Link href={tokenHref} className="hover:underline">
                  {detail.nftContract.slice(0, 6)}…{detail.nftContract.slice(-4)} #
                  {detail.tokenId}
                </Link>
              </dd>
              <dt className="text-[10px] font-mono uppercase tracking-wider text-gray-400">
                {detail.source === "foundation" ? "Market" : "House"}
              </dt>
              <dd className="text-[10px] font-mono truncate">
                <a
                  href={`https://evm.now/address/${detail.marketAddress}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="hover:underline"
                >
                  {detail.marketAddress.slice(0, 6)}…{detail.marketAddress.slice(-4)} ↗
                </a>
              </dd>
              <dt className="text-[10px] font-mono uppercase tracking-wider text-gray-400">
                Auction ID
              </dt>
              <dd className="text-[10px] font-mono">{detail.auctionId}</dd>
            </dl>
          </section>
        </aside>
      </div>
    </div>
  )
}
