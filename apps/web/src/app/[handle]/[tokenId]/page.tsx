import type { Metadata } from "next"
import { Suspense } from "react"
import { SITE_TITLE, ipfsToHttp } from "@pin/shared"
import { FOUNDATION_NFT, MAINNET_CHAIN_ID } from "@pin/addresses"
import { Provenance, type ProvenanceEntry } from "@/components/Provenance"
import { AuctionPanel } from "@/components/auction/AuctionPanel"
import { MoreFromContractSection } from "@/components/auction/MoreFromContract"
import { StartAuctionCTA } from "@/components/auction/StartAuctionCTA"
import { TokenMedia } from "@/components/token/TokenMedia"
import {
  getErc1155TokenStats,
  getTokenOnChainData,
  resolveTokenMetadataDirect,
} from "@/lib/onchain-discovery"
import { getAuctionForToken } from "@/lib/auctions"
import { getSettledAuctionForToken } from "@/lib/indexer-queries"
import { SettledAuctionSummary } from "@/components/auction/SettledAuctionSummary"
import { resolveDisplayNames } from "@/lib/artist-queries"
import Link from "next/link"

type Params = Promise<{ handle: string; tokenId: string }>

function truncateAddress(addr: string): string {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`
}

async function getTokenPageData(handle: string, tokenId: string) {
  const isAddress = handle.startsWith("0x") && handle.length === 42
  const contract = isAddress ? handle : FOUNDATION_NFT[MAINNET_CHAIN_ID]

  // Fetch metadata, ERC721 on-chain data, and ERC1155 stats in parallel.
  // ERC1155 returns null on ERC721 contracts (and vice-versa for the ERC721
  // path), so we naturally end up with whichever standard the token uses.
  const [meta, onChainData, erc1155] = await Promise.all([
    resolveTokenMetadataDirect(contract, tokenId),
    getTokenOnChainData(contract, tokenId).catch(() => null),
    getErc1155TokenStats(contract, tokenId).catch(() => null),
  ])

  const imageUrl = meta?.image
    ? ipfsToHttp(meta.image)
    : "https://placehold.co/1200x1500/F2F2F2/999999?text=Artwork"

  const isErc1155 = !!erc1155 && erc1155.transfers.length > 0
  const creator = (onChainData?.creator || erc1155?.creator) ?? ""
  const owner = onChainData?.owner ?? "" // n/a for ERC1155

  const provenance: ProvenanceEntry[] = isErc1155
    ? erc1155!.transfers.map((t) => ({
        event:
          t.from === "0x0000000000000000000000000000000000000000"
            ? "Minted"
            : "Transferred",
        from: t.from,
        fromHandle: truncateAddress(t.from),
        to: t.to,
        toHandle: truncateAddress(t.to),
        timestamp: t.timestamp,
        txHash: t.txHash,
        amount: t.amount,
      }))
    : (onChainData?.transfers ?? [])
        .sort((a, b) => b.timestamp - a.timestamp)
        .map((t) => ({
          event:
            t.from === "0x0000000000000000000000000000000000000000"
              ? "Minted"
              : "Transferred",
          from: t.from,
          fromHandle: truncateAddress(t.from),
          to: t.to,
          toHandle: truncateAddress(t.to),
          timestamp: t.timestamp,
          txHash: t.txHash,
        }))

  return {
    title: meta?.name ?? `#${tokenId}`,
    description: meta?.description ?? "",
    creator,
    creatorHandle: creator ? truncateAddress(creator) : "",
    owner,
    ownerHandle: owner ? truncateAddress(owner) : "",
    contract,
    tokenId,
    imageUrl,
    provenance,
    isErc1155,
    edition: isErc1155 ? erc1155!.totalSupply : null,
    ownerCount: isErc1155 ? erc1155!.ownerCount : null,
  }
}

export async function generateMetadata({
  params,
}: {
  params: Params
}): Promise<Metadata> {
  const { handle, tokenId } = await params
  const data = await getTokenPageData(handle, tokenId)
  const ogTitle = `${data.title} by ${data.creatorHandle || "Unknown"} | ${SITE_TITLE}`
  const description =
    data.description ||
    `${data.title} by ${data.creatorHandle || "Unknown"}`
  return {
    title: `${data.title} by ${data.creatorHandle || "Unknown"}`,
    description,
    openGraph: {
      title: ogTitle,
      description,
      images: [data.imageUrl],
    },
    twitter: {
      card: "summary_large_image",
      title: ogTitle,
      description,
      images: [data.imageUrl],
    },
  }
}

export default async function TokenPage({
  params,
}: {
  params: Params
}) {
  const { handle, tokenId } = await params
  const data = await getTokenPageData(handle, tokenId)
  const [auction, settledAuctionRaw] = await Promise.all([
    getAuctionForToken(data.contract, tokenId).catch(() => null),
    getSettledAuctionForToken(data.contract, tokenId).catch(() => null),
  ])
  const settledAuction = !auction ? settledAuctionRaw : null

  // Upgrade truncated 0x… handles to ENS where available — for the creator,
  // the owner, AND every distinct address in the provenance timeline so the
  // history reads as `alice.eth → bob.eth ×3` instead of raw 0x….
  const addressSet = new Set<string>()
  if (data.creator) addressSet.add(data.creator.toLowerCase())
  if (data.owner) addressSet.add(data.owner.toLowerCase())
  for (const entry of data.provenance) {
    addressSet.add(entry.from.toLowerCase())
    if (entry.to) addressSet.add(entry.to.toLowerCase())
  }
  if (settledAuction) {
    if (settledAuction.seller) addressSet.add(settledAuction.seller.toLowerCase())
    if (settledAuction.winner) addressSet.add(settledAuction.winner.toLowerCase())
    for (const bid of settledAuction.bids) {
      addressSet.add(bid.bidder.toLowerCase())
    }
  }
  if (addressSet.size > 0) {
    const names = await resolveDisplayNames(Array.from(addressSet)).catch(
      () => new Map<string, string>(),
    )
    if (data.creator) {
      data.creatorHandle = names.get(data.creator.toLowerCase()) ?? data.creatorHandle
    }
    if (data.owner) {
      data.ownerHandle = names.get(data.owner.toLowerCase()) ?? data.ownerHandle
    }
    data.provenance = data.provenance.map((entry) => ({
      ...entry,
      fromHandle: names.get(entry.from.toLowerCase()) ?? entry.fromHandle,
      toHandle: entry.to
        ? names.get(entry.to.toLowerCase()) ?? entry.toHandle
        : entry.toHandle,
    }))
    if (settledAuction) {
      const sellerName = names.get(settledAuction.seller.toLowerCase())
      settledAuction.sellerDisplay = settledAuction.seller
        ? sellerName ?? truncateAddress(settledAuction.seller)
        : ""
      const winnerName = names.get(settledAuction.winner.toLowerCase())
      settledAuction.winnerDisplay = settledAuction.winner
        ? winnerName ?? truncateAddress(settledAuction.winner)
        : ""
      settledAuction.bids = settledAuction.bids.map((bid) => ({
        ...bid,
        bidderDisplay:
          names.get(bid.bidder.toLowerCase()) ?? truncateAddress(bid.bidder),
      }))
    }
  }

  return (
    <div className="mx-auto max-w-[2000px]">
      {/* Desktop: 2/3 sticky artwork + 1/3 scrolling sidebar. Mobile: stacked. */}
      <div className="grid grid-cols-1 lg:grid-cols-[2fr_1fr] min-h-[calc(100vh-64px)]">
        {/* Left: sticky artwork */}
        <div className="lg:sticky lg:top-16 lg:h-[calc(100vh-64px)] flex items-center justify-center bg-gray-100 p-8 lg:p-12">
          <TokenMedia url={data.imageUrl} title={data.title} />
        </div>

        {/* Right: scrolling sidebar */}
        <aside className="lg:border-l border-gray-200 px-6 py-8 lg:px-8 lg:py-10">
          {/* Title + creator */}
          <section className="pb-5 border-b border-gray-100 space-y-2">
            {data.creator && (
              <Link
                href={`/artist/${data.creator}`}
                className="block text-[11px] font-mono uppercase tracking-wider text-gray-600 hover:text-black transition-colors"
              >
                {data.creatorHandle}
              </Link>
            )}
            <h1 className="text-base font-mono font-medium tracking-tight">
              {data.title}
            </h1>
          </section>

          {/* Description (only prose section — uses Switzer) */}
          {data.description && (
            <section className="py-5 border-b border-gray-100">
              <p className="text-sm text-gray-600 leading-relaxed">
                {data.description}
              </p>
            </section>
          )}

          {/* Live auction (Foundation NFTMarket or a sovereign auction
              house). Our houses are ERC721-only so we suppress the start CTA
              for ERC1155 tokens. */}
          {auction && (
            <section className="py-5 border-b border-gray-100">
              <AuctionPanel auction={auction} />
            </section>
          )}
          {!auction && settledAuction && (
            <section className="py-5 border-b border-gray-100">
              <SettledAuctionSummary auction={settledAuction} />
            </section>
          )}
          {!auction && !data.isErc1155 && (
            <section className="py-5 border-b border-gray-100">
              <StartAuctionCTA
                nftContract={data.contract as `0x${string}`}
                tokenId={tokenId}
                tokenTitle={data.title}
              />
            </section>
          )}

          {/* Ownership / edition stats */}
          {data.isErc1155 ? (
            <section className="py-5 border-b border-gray-100">
              <div className="grid grid-cols-3 gap-4">
                <div className="space-y-1">
                  <p className="text-[10px] font-mono uppercase tracking-wider text-gray-400">
                    Edition
                  </p>
                  <p className="text-xs font-mono tabular-nums">
                    {(data.edition ?? 0n).toString()}
                  </p>
                </div>
                <div className="space-y-1">
                  <p className="text-[10px] font-mono uppercase tracking-wider text-gray-400">
                    Holders
                  </p>
                  <p className="text-xs font-mono tabular-nums">
                    {data.ownerCount ?? 0}
                  </p>
                </div>
                <div className="space-y-1">
                  <p className="text-[10px] font-mono uppercase tracking-wider text-gray-400">
                    Standard
                  </p>
                  <p className="text-xs font-mono">ERC1155</p>
                </div>
              </div>
            </section>
          ) : (
            data.owner && (
              <section className="py-5 border-b border-gray-100 space-y-1">
                <p className="text-[10px] font-mono uppercase tracking-wider text-gray-400">
                  Owner
                </p>
                <Link
                  href={`/artist/${data.owner}`}
                  className="text-xs font-mono hover:underline"
                >
                  {data.ownerHandle}
                </Link>
              </section>
            )
          )}

          {/* Provenance */}
          <section className="py-5 border-b border-gray-100">
            <Provenance entries={data.provenance} />
          </section>

          {/* Contract info */}
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
                  href={`https://evm.now/address/${data.contract}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="hover:underline"
                >
                  {data.contract}
                </a>
              </dd>
              <dt className="text-[10px] font-mono uppercase tracking-wider text-gray-400">
                Token ID
              </dt>
              <dd className="text-[10px] font-mono">{data.tokenId}</dd>
            </dl>
          </section>
        </aside>
      </div>

      {/* "More from this artist on this contract" — streams in below the
          fold so the primary auction render isn't blocked by the log scan. */}
      {data.creator && (
        <Suspense fallback={null}>
          <MoreFromContractSection
            contract={data.contract}
            creator={data.creator}
            creatorDisplay={data.creatorHandle}
            excludeTokenId={tokenId}
          />
        </Suspense>
      )}
    </div>
  )
}

