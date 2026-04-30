import Link from "next/link"
import { formatEther } from "viem"
import type { DiscoveredToken } from "@/lib/onchain-discovery"
import { getCachedEnrichedPage } from "@/lib/artist-cache"
import { getTokensByContractAndCreator } from "@/lib/contract-tokens"
import { getLastSalePriceForToken, type LastSale } from "@/lib/last-sale"

type Props = {
  tokens: DiscoveredToken[]
  /** Keyed by tokenId. Only present for tokens we successfully resolved a sale for. */
  lastSales: Map<string, LastSale>
  /** Display name for the heading. Falls back to truncated address. */
  creatorDisplay?: string
}

type SectionProps = {
  contract: string
  creator: string
  creatorDisplay?: string
  excludeTokenId: string
}

/**
 * Server-side wrapper that fetches siblings + last-sale prices for the two
 * most-recently-minted siblings, then renders. Designed to be wrapped in a
 * Suspense boundary so it streams in below the auction without blocking the
 * primary token render.
 */
export async function MoreFromContractSection({
  contract,
  creator,
  creatorDisplay,
  excludeTokenId,
}: SectionProps) {
  if (!creator) return null

  const refs = await getTokensByContractAndCreator(contract, creator, {
    excludeTokenId,
    limit: 6,
  })
  if (refs.length === 0) return null

  // Enrich all displayed siblings with metadata in parallel with sale lookup
  // for just the 2 most recently minted (refs are already sorted newest-first
  // within Foundation sources).
  const priceTargets = refs.slice(0, 2)
  const [tokens, salesArr] = await Promise.all([
    getCachedEnrichedPage(refs),
    Promise.all(
      priceTargets.map((ref) =>
        getLastSalePriceForToken(ref.contract, ref.tokenId, creator).catch(
          () => null,
        ),
      ),
    ),
  ])

  if (tokens.length === 0) return null

  const lastSales = new Map<string, LastSale>()
  priceTargets.forEach((ref, i) => {
    const sale = salesArr[i]
    if (sale) lastSales.set(ref.tokenId, sale)
  })

  return (
    <MoreFromContract
      tokens={tokens}
      lastSales={lastSales}
      creatorDisplay={creatorDisplay}
    />
  )
}

function formatRelative(timestamp: number): string {
  const diffSec = Math.floor(Date.now() / 1000) - timestamp
  if (diffSec < 60) return "just now"
  const min = Math.floor(diffSec / 60)
  if (min < 60) return `${min}m ago`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr}h ago`
  const day = Math.floor(hr / 24)
  if (day < 30) return `${day}d ago`
  const mo = Math.floor(day / 30)
  if (mo < 12) return `${mo}mo ago`
  const yr = Math.floor(day / 365)
  return `${yr}y ago`
}

function formatPriceEth(wei: bigint): string {
  const eth = formatEther(wei)
  const num = Number(eth)
  if (num >= 1) return `${num.toFixed(2)} ETH`
  if (num >= 0.01) return `${num.toFixed(3)} ETH`
  return `${num.toFixed(4)} ETH`
}

export function MoreFromContract({ tokens, lastSales, creatorDisplay }: Props) {
  if (tokens.length === 0) return null

  const heading = creatorDisplay
    ? `More from ${creatorDisplay}`
    : "More from this contract"

  return (
    <section className="border-t border-gray-200 px-6 py-10 lg:px-12 lg:py-14">
      <h2 className="text-[10px] font-mono font-medium uppercase tracking-wider text-gray-400 mb-6">
        {heading}
      </h2>
      <ul className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-4">
        {tokens.map((token) => {
          const sale = lastSales.get(token.tokenId)
          const title = token.metadata?.name ?? `#${token.tokenId}`
          const href = `/${token.contract}/${token.tokenId}`
          return (
            <li key={`${token.contract}:${token.tokenId}`}>
              <Link
                href={href}
                className="group block border border-gray-200 transition-colors hover:border-gray-400"
              >
                <div className="relative aspect-square overflow-hidden bg-gray-100">
                  {token.mediaHttpUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={token.mediaHttpUrl}
                      alt={title}
                      loading="lazy"
                      className="h-full w-full object-cover"
                    />
                  ) : null}
                </div>
                <div className="p-3 space-y-1">
                  <p className="text-xs font-mono font-medium truncate">
                    {title}
                  </p>
                  {sale ? (
                    <p className="text-[10px] font-mono uppercase tracking-wider text-gray-500">
                      Last sold {formatPriceEth(sale.priceWei)}
                      <span className="text-gray-400">
                        {" · "}
                        {formatRelative(sale.blockTime)}
                      </span>
                    </p>
                  ) : (
                    <p className="text-[10px] font-mono uppercase tracking-wider text-gray-300">
                      &nbsp;
                    </p>
                  )}
                </div>
              </Link>
            </li>
          )
        })}
      </ul>
    </section>
  )
}
