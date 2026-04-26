import type { Metadata } from "next"
import { SITE_TITLE, ipfsToHttp } from "@pin/shared"
import { FOUNDATION_NFT, MAINNET_CHAIN_ID } from "@pin/addresses"
import { Provenance, type ProvenanceEntry } from "@/components/Provenance"
import { AuctionPanel } from "@/components/auction/AuctionPanel"
import { StartAuctionCTA } from "@/components/auction/StartAuctionCTA"
import {
  getErc1155TokenStats,
  getTokenOnChainData,
  resolveTokenMetadataDirect,
} from "@/lib/onchain-discovery"
import { getAuctionForToken } from "@/lib/auctions"
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
  return {
    title: `${data.title} by ${data.creatorHandle || "Unknown"}`,
    description: data.description,
    openGraph: {
      title: `${data.title} by ${data.creatorHandle || "Unknown"} | ${SITE_TITLE}`,
      description: data.description,
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
  const auction = await getAuctionForToken(data.contract, tokenId).catch(() => null)

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
  }

  return (
    <div className="mx-auto max-w-[2000px]">
      {/* Desktop: left/right split. Mobile: stacked. */}
      <div className="flex flex-col lg:flex-row min-h-[calc(100vh-64px)]">
        {/* Left: artwork */}
        <div className="flex items-center justify-center bg-gray-100 lg:w-[60%] p-8 lg:p-16">
          <TokenMedia url={data.imageUrl} title={data.title} />
        </div>

        {/* Right: info panel */}
        <div className="lg:w-[40%] overflow-y-auto">
          <div className="p-6 lg:p-12 space-y-8">
            {/* Creator */}
            <div className="space-y-1">
              {data.creator && (
                <Link
                  href={`/artist/${data.creator}`}
                  className="text-sm text-gray-600 hover:text-black transition-colors"
                >
                  {data.creatorHandle}
                </Link>
              )}
              <h1 className="text-3xl font-semibold tracking-tight">
                {data.title}
              </h1>
            </div>

            {/* Description */}
            {data.description && (
              <p className="text-base text-gray-600 leading-relaxed">
                {data.description}
              </p>
            )}

            {/* Live auction (Foundation or PND). PND auctions are ERC721-only
                so we suppress the start CTA for ERC1155 tokens. */}
            {auction && <AuctionPanel auction={auction} />}
            {!auction && !data.isErc1155 && (
              <StartAuctionCTA
                nftContract={data.contract as `0x${string}`}
                tokenId={tokenId}
                tokenTitle={data.title}
              />
            )}

            {/* Ownership / edition stats */}
            {data.isErc1155 ? (
              <div className="flex items-center gap-6 text-sm">
                <div>
                  <p className="text-xs text-gray-400 uppercase tracking-wider">
                    Edition
                  </p>
                  <p className="font-medium tabular-nums">
                    {(data.edition ?? 0n).toString()}
                  </p>
                </div>
                <div>
                  <p className="text-xs text-gray-400 uppercase tracking-wider">
                    Holders
                  </p>
                  <p className="font-medium tabular-nums">
                    {data.ownerCount ?? 0}
                  </p>
                </div>
                <div>
                  <p className="text-xs text-gray-400 uppercase tracking-wider">
                    Standard
                  </p>
                  <p className="font-medium">ERC1155</p>
                </div>
              </div>
            ) : (
              data.owner && (
                <div className="flex items-center gap-2 text-sm">
                  <span className="text-gray-400">Owned by</span>
                  <Link
                    href={`/artist/${data.owner}`}
                    className="font-medium hover:underline"
                  >
                    {data.ownerHandle}
                  </Link>
                </div>
              )
            )}

            {/* Divider */}
            <div className="border-t border-gray-200" />

            {/* Provenance */}
            <Provenance entries={data.provenance} />

            {/* Contract info */}
            <div className="border-t border-gray-200 pt-6 space-y-2">
              <h3 className="text-sm font-medium text-gray-400 uppercase tracking-wider">
                Contract
              </h3>
              <div className="grid grid-cols-2 gap-2 text-sm">
                <span className="text-gray-400">Contract</span>
                <a
                  href={`https://evm.now/address/${data.contract}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="font-mono text-xs truncate hover:underline"
                >
                  {data.contract}
                </a>
                <span className="text-gray-400">Token ID</span>
                <span className="font-mono text-xs">{data.tokenId}</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

const VIDEO_EXTENSIONS = [".mp4", ".mov", ".webm", ".ogv"]

function TokenMedia({ url, title }: { url: string; title: string }) {
  const path = url.split("?")[0].toLowerCase()
  const isVideo = VIDEO_EXTENSIONS.some((ext) => path.endsWith(ext))

  if (isVideo) {
    return (
      <video
        src={url}
        className="max-h-[80vh] w-auto object-contain"
        autoPlay
        loop
        muted
        playsInline
        controls
      />
    )
  }

  return (
    <img
      src={url}
      alt={title}
      className="max-h-[80vh] w-auto object-contain"
    />
  )
}
