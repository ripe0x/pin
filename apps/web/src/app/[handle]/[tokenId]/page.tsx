import type { Metadata } from "next"
import { Suspense, cache } from "react"
import { SITE_TITLE, ipfsToHttp } from "@pin/shared"
import { FOUNDATION_NFT, MAINNET_CHAIN_ID } from "@pin/addresses"
import { Provenance, type ProvenanceEntry } from "@/components/Provenance"
import { AuctionPanel } from "@/components/auction/AuctionPanel"
import { MoreFromContractSection } from "@/components/auction/MoreFromContract"
import { StartAuctionCTA } from "@/components/auction/StartAuctionCTA"
import { RefreshMetadataButton } from "@/components/token/RefreshMetadataButton"
import { TokenMedia } from "@/components/token/TokenMedia"
import {
  getErc1155TokenStats,
  getTokenOnChainData,
  resolveTokenMetadataDirect,
} from "@/lib/onchain-discovery"
import { getAuctionForToken, type AuctionState } from "@/lib/auctions"
import { getSettledAuctionForToken } from "@/lib/indexer-queries"
import { SettledAuctionSummary } from "@/components/auction/SettledAuctionSummary"
import { getArtistIdentity, resolveDisplayNames } from "@/lib/artist-queries"
import { isCrawler } from "@/lib/crawler"
import Link from "next/link"

type Params = Promise<{ handle: string; tokenId: string }>

function truncateAddress(addr: string): string {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`
}

// Wrapped in React's `cache()` so calls within the same request — there
// are two: one in `generateMetadata`, one in the page body — share a
// single result. Without this, the metadata + body each ran the full
// fetch independently, doubling RPC fan-out on every cold token-page
// request. `cache()` is React's built-in request-scoped memoization;
// state doesn't leak across requests.
const getTokenPageData = cache(async (handle: string, tokenId: string) => {
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
  const animationUrl = meta?.animation_url
    ? ipfsToHttp(meta.animation_url)
    : null

  // Verification links: the canonical metadata source (tokenURI) and the
  // artwork, resolved to an HTTP gateway. `data:` URIs are inline JSON with
  // nothing external to open, so skip the metadata link for those.
  const metadataSourceUrl =
    meta?.rawUri && !meta.rawUri.startsWith("data:")
      ? ipfsToHttp(meta.rawUri)
      : null
  const artworkSourceUrl = meta?.animation_url
    ? ipfsToHttp(meta.animation_url)
    : meta?.image
      ? ipfsToHttp(meta.image)
      : null

  // A token is ERC1155 if the indexer has 1155 stats for it. The old check
  // also required `transfers.length > 0`, but the v2 stats reader always
  // returns `transfers: []`, so it was never true — 1155 tokens fell through
  // to the ERC721 path (no edition grid, spurious start-auction CTA).
  const isErc1155 = !!erc1155
  const creator = (onChainData?.creator || erc1155?.creator) ?? ""
  const owner = onChainData?.owner ?? "" // n/a for ERC1155

  const creatorAvatarUrl = creator
    ? (await getArtistIdentity(creator).catch(() => null))?.avatarUrl ?? null
    : null

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
        .slice()
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
    creatorAvatarUrl,
    owner,
    ownerHandle: owner ? truncateAddress(owner) : "",
    contract,
    tokenId,
    imageUrl,
    animationUrl,
    metadataSourceUrl,
    artworkSourceUrl,
    provenance,
    isErc1155,
    edition: isErc1155 ? erc1155!.totalSupply : null,
    ownerCount: isErc1155 ? erc1155!.ownerCount : null,
  }
})

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

  // Crawlers (Twitterbot, Discord, Slack, etc.) only need OG metadata.
  // `generateMetadata` already produced the title + description + image
  // they care about; the body's RPC reads (auction state, settled-auction
  // bid history, ENS resolution across the provenance timeline) are all
  // wasted on a link unfurler. Short-circuit so a burst of unfurl traffic
  // can't fan out to RPC per crawler hit. Real users land on the full
  // path below.
  if (await isCrawler()) {
    return (
      <div className="mx-auto max-w-[2000px] px-6 py-12">
        <p className="text-sm text-gray-500">Loading token…</p>
      </div>
    )
  }

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
    <div>
      {/* Desktop: 2/3 sticky artwork + 1/3 scrolling sidebar. Mobile: stacked.
          Full-bleed (no max-width) so the gray artwork field always runs to
          the left edge of the viewport. */}
      <div className="grid grid-cols-1 lg:grid-cols-[2fr_1fr] min-h-[calc(100vh-64px)]">
        {/* Left: sticky artwork */}
        <div className="lg:sticky lg:top-16 lg:h-[calc(100vh-64px)] flex items-center justify-center bg-gray-100 dark:bg-bg p-8 lg:p-12">
          <TokenMedia
            imageUrl={data.imageUrl}
            animationUrl={data.animationUrl}
            title={data.title}
          />
        </div>

        {/* Right: scrolling sidebar */}
        <aside className="lg:border-l border-gray-200 dark:bg-gray-100 px-6 py-8 lg:px-8 lg:py-10">
          {/* Title + creator */}
          <section className="pb-5 border-b border-gray-100 space-y-2">
            {data.creator && (
              <Link
                href={`/artist/${data.creator}`}
                className="inline-flex items-center gap-2 text-[11px] font-mono uppercase tracking-wider text-gray-600 hover:text-fg transition-colors"
              >
                {data.creatorAvatarUrl && (
                  <img
                    src={data.creatorAvatarUrl}
                    alt=""
                    className="h-4 w-4 rounded-full object-cover"
                  />
                )}
                <span>{data.creatorHandle}</span>
              </Link>
            )}
            <h1 className="text-base font-mono font-medium tracking-tight">
              {data.title}
            </h1>
            {data.isErc1155 && data.edition != null && (
              <p className="text-[11px] font-mono text-gray-400">
                Edition of {data.edition.toString()}
              </p>
            )}
          </section>

          {/* Description (only prose section — uses Switzer) */}
          {data.description && (
            <section className="py-5 border-b border-gray-100">
              <p className="text-sm text-gray-600 leading-relaxed whitespace-pre-line">
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
          {/* StartAuctionCTA renders its own bordered section only when the
              viewer is the current owner with a deployed house — otherwise it
              returns null, so we don't wrap it in a section here (that left an
              empty bordered band for every non-owner viewer). */}
          {!auction && !data.isErc1155 && (
            <StartAuctionCTA
              nftContract={data.contract as `0x${string}`}
              tokenId={tokenId}
              tokenTitle={data.title}
            />
          )}

          {/* Owner — ERC721 only. ERC1155 has no single owner; its edition
              size shows under the title and the standard lives in Contract. */}
          {!data.isErc1155 && data.owner && (
            <OwnerOrEscrowSection
              owner={data.owner}
              ownerHandle={data.ownerHandle}
              auction={auction}
            />
          )}

          {/* Provenance — only when there's history. `Provenance` itself
              renders nothing for an empty list, so without this guard the
              section's padding + border-b leave an empty bordered band. */}
          {data.provenance.length > 0 && (
            <section className="py-5 border-b border-gray-100">
              <Provenance entries={data.provenance} />
            </section>
          )}

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
              <dt className="text-[10px] font-mono uppercase tracking-wider text-gray-400">
                Standard
              </dt>
              <dd className="text-[10px] font-mono">{data.isErc1155 ? "ERC1155" : "ERC721"}</dd>
            </dl>
          </section>

          {/* Source / verification links — open the canonical on-chain
              metadata and artwork so anyone can verify the record. */}
          {(data.metadataSourceUrl || data.artworkSourceUrl) && (
            <section className="pt-5">
              <h3 className="text-[10px] font-mono font-medium uppercase tracking-wider text-gray-400 mb-3">
                Source
              </h3>
              <div className="flex flex-col gap-2">
                {data.metadataSourceUrl && (
                  <a
                    href={data.metadataSourceUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-[10px] font-mono hover:underline"
                  >
                    Metadata ↗
                  </a>
                )}
                {data.artworkSourceUrl && (
                  <a
                    href={data.artworkSourceUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-[10px] font-mono hover:underline"
                  >
                    Artwork ↗
                  </a>
                )}
              </div>
            </section>
          )}

          {/* Re-fetch metadata if the title/image is stale or stuck. Sits
              under the Source list since it acts on the same source data.
              Self-gates: visible to the token's owner/creator, and to site
              admins on every token page. Rate-limited server-side. */}
          <div className="pt-5">
            <RefreshMetadataButton
              contract={data.contract}
              tokenId={data.tokenId}
              owner={data.owner}
              creator={data.creator}
            />
          </div>
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

function OwnerOrEscrowSection({
  owner,
  ownerHandle,
  auction,
}: {
  owner: string
  ownerHandle: string
  auction: AuctionState | null
}) {
  const inEscrow =
    !!auction &&
    auction.marketAddress.toLowerCase() === owner.toLowerCase()

  if (inEscrow) {
    const platformLabel = escrowPlatformLabel(auction)
    return (
      <section className="py-5 border-b border-gray-100 space-y-1">
        <p className="text-[10px] font-mono uppercase tracking-wider text-gray-400">
          Held in escrow
        </p>
        <p className="text-xs font-mono">
          <span>{platformLabel}&rsquo;s </span>
          <a
            href={`https://evm.now/address/${owner}`}
            target="_blank"
            rel="noreferrer"
            className="hover:underline"
          >
            auction contract
          </a>
        </p>
      </section>
    )
  }

  return (
    <section className="py-5 border-b border-gray-100 space-y-1">
      <p className="text-[10px] font-mono uppercase tracking-wider text-gray-400">
        Owner
      </p>
      <Link
        href={`/artist/${owner}`}
        className="text-xs font-mono hover:underline"
      >
        {ownerHandle}
      </Link>
    </section>
  )
}

function escrowPlatformLabel(auction: AuctionState): string {
  switch (auction.source) {
    case "foundation":
      return "Foundation"
    case "sovereign":
      return auction.sellerDisplay
    case "superrareV2":
      return "SuperRare"
    case "transient":
      return "Transient"
    default:
      return "this"
  }
}

