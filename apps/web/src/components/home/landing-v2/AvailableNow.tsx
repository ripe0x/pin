import Link from "next/link"
import { formatEther } from "viem"
import { Artwork } from "@/components/media/Artwork"
import { getActivePndAuctions, type ActivePndAuction } from "@/lib/indexer-queries"
import { resolveTokenMetadataDirect } from "@/lib/onchain-discovery"
import { getDisplayMedia, type DisplayMedia } from "@/lib/display-media"

const MAX_ITEMS = 6
const NO_ARTWORK: DisplayMedia = { kind: "none" }

type AuctionCardData = {
  auction: ActivePndAuction
  title: string | null
  artwork: DisplayMedia
}

/** Live PND auctions across every artist-owned house. Surface releases
 * have their own venue section above this one. */
export async function AvailableNow() {
  const indexedAuctions = await getActivePndAuctions(MAX_ITEMS).catch(() => null)
  const now = Math.floor(Date.now() / 1000)

  const activeAuctions = (indexedAuctions ?? []).filter(
    (auction) => auction.endTime === 0 || auction.endTime > now,
  )
  const auctionArtwork = await getDisplayMedia(
    activeAuctions.map((a) => ({ contract: a.tokenContract, tokenId: a.tokenId })),
  ).catch(() => new Map<string, DisplayMedia>())
  const auctionCards = await Promise.all(
    activeAuctions.map(async (auction): Promise<AuctionCardData> => {
      const meta = await resolveTokenMetadataDirect(
        auction.tokenContract,
        auction.tokenId,
      ).catch(() => null)
      return {
        auction,
        title: meta?.name ?? null,
        artwork:
          auctionArtwork.get(`${auction.tokenContract.toLowerCase()}:${auction.tokenId}`) ??
          NO_ARTWORK,
      }
    }),
  )

  const items = auctionCards.slice(0, MAX_ITEMS)

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
          {items.map((item) => (
              <AuctionCard
                key={`auction:${item.auction.house}:${item.auction.auctionId}`}
                card={item}
                now={now}
              />
          ))}
        </ul>
      ) : indexedAuctions === null ? (
        <div className="rounded-md border border-gray-200 p-5">
          <p className="text-sm text-fg-muted">
            Live availability is temporarily unavailable. Browse artist
            profiles or try again shortly.
          </p>
        </div>
      ) : (
        <div className="rounded-md border border-gray-200 p-5">
          <p className="text-sm text-fg-muted">
            No auctions are open right now.
          </p>
        </div>
      )}

      <div className="flex flex-wrap gap-x-5 gap-y-2 text-xs font-mono">
        <Link href="/auctions" className="underline underline-offset-4 hover:text-gray-600">
          All auctions
        </Link>
      </div>
    </section>
  )
}

function AuctionCard({ card, now }: { card: AuctionCardData; now: number }) {
  const { auction, title, artwork } = card
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
          <Artwork media={artwork} alt={title ?? `Token #${auction.tokenId}`} />
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
