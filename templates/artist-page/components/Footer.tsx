/**
 * Index-page footer. Mirrors the PND main app's footer pattern: top
 * border separator, site label on the left, explorer/contract pills
 * on the right.
 */
import { getConfig, SOVEREIGN_FACTORY_ADDRESS } from "@/lib/config"
import { getArtistDisplayName } from "@/lib/artist"
import { getArtistHouse } from "@/lib/auctions"
import { explorerAddressUrl } from "@/lib/explorer"

export async function Footer() {
  const cfg = getConfig()
  const displayName = await getArtistDisplayName()
  const house = await getArtistHouse()

  return (
    <footer className="border-t border-gray-200 pt-8 pb-16">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-sm text-gray-400">
          {displayName} — on-chain auctions
        </p>
        <div className="flex flex-wrap gap-6 text-sm text-gray-400">
          <a
            href={explorerAddressUrl(cfg.artistAddress)}
            target="_blank"
            rel="noopener noreferrer"
            className="hover:text-fg transition-colors"
          >
            Wallet ↗
          </a>
          {house && (
            <a
              href={explorerAddressUrl(house)}
              target="_blank"
              rel="noopener noreferrer"
              className="hover:text-fg transition-colors"
            >
              Auction house ↗
            </a>
          )}
          <a
            href={explorerAddressUrl(SOVEREIGN_FACTORY_ADDRESS)}
            target="_blank"
            rel="noopener noreferrer"
            className="hover:text-fg transition-colors"
          >
            Factory ↗
          </a>
        </div>
      </div>
    </footer>
  )
}
