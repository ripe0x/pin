import Link from "next/link"
import { formatEther } from "viem"
import { ipfsToHttp } from "@pin/shared"
import { AvailableArtwork } from "./AvailableArtwork"
import { getRecentCollections } from "@/lib/collection-onchain"
import {
  SurfaceStatus,
  ZERO_ADDRESS,
  formatPriceLabel,
  hasPriceStrategy,
  lifecycleStatus,
  saleWindowOf,
  surfaceFactory,
  type Collection,
} from "@/lib/collection"
import { getActivePndAuctions, type ActivePndAuction } from "@/lib/indexer-queries"
import { getCollectionArtwork } from "@/lib/collection-artwork"
import { resolveTokenMetadataDirect } from "@/lib/onchain-discovery"

const MAX_ITEMS = 6

type AuctionCardData = {
  auction: ActivePndAuction
  title: string | null
  mediaUrl: string | null
}

type AvailableItem =
  | { type: "release"; value: Collection }
  | { type: "auction"; value: AuctionCardData }

type Props = {
  // Recent collections already fetched by the caller. ReleaseVenue passes
  // its own list so the two sections share one fetch.
  collections?: Collection[] | null
  // Display image per collection (lowercase address), from the caller when
  // it already resolved them.
  artwork?: Map<string, string>
}

export async function AvailableNow({ collections: given, artwork: givenArtwork }: Props = {}) {
  const factory = surfaceFactory()
  const [collections, indexedAuctions] = await Promise.all([
    given !== undefined
      ? Promise.resolve(given)
      : factory
        ? getRecentCollections(factory, 12).catch(() => null)
        : Promise.resolve(null),
    getActivePndAuctions(6).catch(() => null),
  ])
  const now = Math.floor(Date.now() / 1000)

  const openReleases = (collections ?? [])
    .filter(
      (c) => lifecycleStatus(saleWindowOf(c), c.minted, now) === SurfaceStatus.Open,
    )
    .slice(0, 4)
  const artwork = givenArtwork ?? (await getCollectionArtwork(openReleases))

  const activeAuctions = (indexedAuctions ?? []).filter(
    (auction) => auction.endTime === 0 || auction.endTime > now,
  )
  const auctionCards = await Promise.all(
    activeAuctions.map(async (auction): Promise<AuctionCardData> => {
      const meta = await resolveTokenMetadataDirect(
        auction.tokenContract,
        auction.tokenId,
      ).catch(() => null)
      return {
        auction,
        title: meta?.name ?? null,
        mediaUrl: meta?.image ? ipfsToHttp(meta.image) : null,
      }
    }),
  )

  const items: AvailableItem[] = [
    ...openReleases.map((value) => ({ type: "release" as const, value })),
    ...auctionCards.map((value) => ({ type: "auction" as const, value })),
  ].slice(0, MAX_ITEMS)

  return (
    <section aria-labelledby="available-now" className="space-y-5">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="text-[11px] font-mono font-medium uppercase tracking-wider text-status-available">
            Live availability
          </p>
          <h2 id="available-now" className="mt-1 text-2xl font-semibold tracking-tight">
            Available now
          </h2>
        </div>
        <p className="text-xs font-mono text-gray-500">
          Current contract state, checked before you transact
        </p>
      </div>

      {items.length > 0 ? (
        <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {items.map((item) =>
            item.type === "release" ? (
              <ReleaseCard
                key={`release:${item.value.address}`}
                release={item.value}
                artwork={artwork.get(item.value.address.toLowerCase()) ?? null}
              />
            ) : (
              <AuctionCard
                key={`auction:${item.value.auction.house}:${item.value.auction.auctionId}`}
                card={item.value}
                now={now}
              />
            ),
          )}
        </ul>
      ) : collections === null && indexedAuctions === null ? (
        <div className="rounded-md border border-gray-200 p-5">
          <p className="text-sm text-fg-muted">
            Live availability is temporarily unavailable. Browse artist
            profiles or try again shortly.
          </p>
        </div>
      ) : (
        <div className="rounded-md border border-gray-200 p-5">
          <p className="text-sm text-fg-muted">
            No PND-native releases or auctions are open right now.
          </p>
        </div>
      )}

      <div className="flex flex-wrap gap-x-5 gap-y-2 text-xs font-mono">
        <Link href="/collections" className="underline underline-offset-4 hover:text-gray-600">
          All releases
        </Link>
        <Link href="/auctions" className="underline underline-offset-4 hover:text-gray-600">
          All auctions
        </Link>
      </div>
    </section>
  )
}

function ReleaseCard({ release, artwork }: { release: Collection; artwork: string | null }) {
  const priceStrategy = release.sale?.priceStrategy ?? ZERO_ADDRESS
  const priceLabel = hasPriceStrategy(priceStrategy)
    ? "Live price"
    : formatPriceLabel(release.sale?.price ?? 0n)
  const cap = smallestPositive(release.cfg.supplyCap, release.sale?.maxMints ?? 0n)
  const quantity = cap > 0n
    ? `${Number(release.minted)} / ${Number(cap)} minted`
    : `${Number(release.minted)} minted`

  return (
    <li>
      <Link
        href={`/collections/${release.address}`}
        className="group block h-full overflow-hidden rounded-md border border-gray-200 bg-surface transition-colors hover:border-gray-400"
      >
        <div className="aspect-[4/3] overflow-hidden bg-gray-100">
          <AvailableArtwork src={artwork} alt={release.name} />
        </div>
        <div className="space-y-3 p-4">
          <div className="flex items-center justify-between gap-3">
            <span className="inline-flex items-center gap-1.5 text-[10px] font-mono font-medium uppercase tracking-wider text-status-available">
              <span className="h-1.5 w-1.5 rounded-full bg-status-available" aria-hidden="true" />
              Open release
            </span>
            <span className="text-[10px] font-mono text-gray-500">PND Surface</span>
          </div>
          <div>
            <h3 className="truncate text-base font-medium tracking-tight">{release.name}</h3>
            <p className="mt-1 truncate text-xs font-mono text-gray-500">
              by {shortAddress(release.owner)}
            </p>
          </div>
          <div className="flex items-end justify-between gap-3 border-t border-gray-200 pt-3">
            <div>
              <p className="text-[10px] font-mono uppercase tracking-wider text-gray-500">Price</p>
              <p className="mt-0.5 text-sm font-mono tabular-nums">{priceLabel}</p>
            </div>
            <p className="text-right text-[11px] font-mono text-gray-600">{quantity}</p>
          </div>
        </div>
      </Link>
    </li>
  )
}

function AuctionCard({ card, now }: { card: AuctionCardData; now: number }) {
  const { auction, title, mediaUrl } = card
  const hasBid = auction.firstBidTime > 0
  const price = hasBid ? auction.amount : auction.reservePrice
  const status =
    auction.endTime === 0
      ? "Waiting for first bid"
      : `Ends ${formatEndsIn(auction.endTime - now)}`
  const quantityLabel =
    auction.tokenStandard === "erc1155" && auction.quantity > 1n
      ? ` · ${auction.quantity} editions`
      : ""

  return (
    <li>
      <Link
        href={`/auction/${auction.house}/${auction.auctionId}`}
        className="group block h-full overflow-hidden rounded-md border border-gray-200 bg-surface transition-colors hover:border-gray-400"
      >
        <div className="aspect-[4/3] overflow-hidden bg-gray-100">
          <AvailableArtwork src={mediaUrl} alt={title ?? `Token #${auction.tokenId}`} />
        </div>
        <div className="space-y-3 p-4">
          <div className="flex items-center justify-between gap-3">
            <span className="inline-flex items-center gap-1.5 text-[10px] font-mono font-medium uppercase tracking-wider text-status-available">
              <span className="h-1.5 w-1.5 rounded-full bg-status-available" aria-hidden="true" />
              Open auction
            </span>
            <span className="text-[10px] font-mono text-gray-500">Artist-owned house</span>
          </div>
          <div>
            <h3 className="truncate text-base font-medium tracking-tight">
              {title ?? `Token #${auction.tokenId}`}
            </h3>
            <p className="mt-1 truncate text-xs font-mono text-gray-500">
              by {shortAddress(auction.seller)}
            </p>
          </div>
          <div className="flex items-end justify-between gap-3 border-t border-gray-200 pt-3">
            <div>
              <p className="text-[10px] font-mono uppercase tracking-wider text-gray-500">
                {hasBid ? "Current bid" : "Reserve"}
              </p>
              <p className="mt-0.5 text-sm font-mono tabular-nums">{formatEth(price)}</p>
            </div>
            <p className="text-right text-[11px] font-mono text-gray-600">
              {status}
              {quantityLabel}
            </p>
          </div>
        </div>
      </Link>
    </li>
  )
}

function smallestPositive(a: bigint, b: bigint): bigint {
  if (a === 0n) return b
  if (b === 0n) return a
  return a < b ? a : b
}

function formatEth(wei: bigint): string {
  const value = Number(formatEther(wei))
  const digits = value >= 1 ? 3 : 4
  return `${value.toLocaleString("en-US", { maximumFractionDigits: digits })} ETH`
}

function shortAddress(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`
}

function formatEndsIn(seconds: number): string {
  if (seconds < 3600) return `${Math.max(1, Math.ceil(seconds / 60))}m`
  if (seconds < 86_400) return `${Math.ceil(seconds / 3600)}h`
  return `${Math.ceil(seconds / 86_400)}d`
}
