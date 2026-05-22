/**
 * Site footer. Mirrors the PND main app's footer pattern: top border
 * separator, label on the left, links + theme toggle on the right (no
 * arrows). Rendered at the bottom of every page.
 */
import { getArtistDisplayName } from "@/lib/artist"
import { getArtistHouse } from "@/lib/auctions"
import { explorerAddressUrl } from "@/lib/explorer"
import { ThemeToggle } from "./ThemeToggle"

export async function Footer() {
  const displayName = await getArtistDisplayName()
  const house = await getArtistHouse()

  return (
    <footer className="border-t border-gray-200 pt-8 pb-16">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-sm text-gray-400">
          {displayName}&rsquo;s{" "}
          {house ? (
            <a
              href={explorerAddressUrl(house)}
              target="_blank"
              rel="noopener noreferrer"
              className="hover:text-fg transition-colors"
            >
              independent auction house
            </a>
          ) : (
            "independent auction house"
          )}
        </p>
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-sm text-gray-400">
          <a
            href="https://pnd.ripe.wtf"
            target="_blank"
            rel="noopener noreferrer"
            className="hover:text-fg transition-colors"
          >
            pnd.ripe.wtf
          </a>
          <span>
            Created by{" "}
            <a
              href="https://x.com/ripe0x"
              target="_blank"
              rel="noopener noreferrer"
              className="hover:text-fg transition-colors"
            >
              ripe
            </a>
          </span>
          <ThemeToggle />
        </div>
      </div>
    </footer>
  )
}
