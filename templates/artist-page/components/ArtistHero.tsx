/**
 * Hero section for the index page — mirrors the PND main app's
 * `ArtistHeader`: avatar + name + truncated address + stat counts + pill row.
 *
 * Avatar / bio / links resolve through the env-then-ENS fallback chain in
 * `lib/artist.ts`, so artists who only set their wallet address still get a
 * filled-in profile.
 */
import { getConfig } from "@/lib/config"
import {
  getArtistDisplayName,
  getArtistAvatarUrl,
  getArtistBio,
  getArtistLinks,
} from "@/lib/artist"
import { getArtistHouse } from "@/lib/auctions"
import { explorerAddressUrl } from "@/lib/explorer"
import { formatAddress } from "@/lib/format"
import { getEnsName } from "@/lib/ens"

type Props = {
  totalAuctions: number
  activeAuctions: number
}

export async function ArtistHero({ totalAuctions, activeAuctions }: Props) {
  const cfg = getConfig()
  const [displayName, avatarUrl, bio, links, ens, house] = await Promise.all([
    getArtistDisplayName(),
    getArtistAvatarUrl(),
    getArtistBio(),
    getArtistLinks(),
    getEnsName(cfg.artistAddress),
    getArtistHouse(),
  ])
  const showAddressUnderName = !!ens || !!cfg.artistName

  return (
    <div className="flex flex-col sm:flex-row items-start gap-6">
      {avatarUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={avatarUrl}
          alt={displayName}
          className="h-20 w-20 shrink-0 rounded-full object-cover"
        />
      ) : (
        <div
          className="h-20 w-20 shrink-0 rounded-full"
          style={{
            background: `linear-gradient(135deg, ${addressToColor(cfg.artistAddress, 0)} 0%, ${addressToColor(cfg.artistAddress, 10)} 100%)`,
          }}
          aria-hidden
        />
      )}

      <div className="space-y-2 min-w-0">
        <h1 className="text-3xl font-semibold tracking-tight truncate">
          {displayName}
        </h1>
        {showAddressUnderName && (
          <p className="font-mono text-xs text-gray-400">
            {formatAddress(cfg.artistAddress)}
          </p>
        )}
        {bio ? (
          <p className="max-w-2xl text-sm text-fg-muted">{bio}</p>
        ) : null}

        <div className="flex items-center gap-4 text-sm text-gray-500 pt-1">
          <span>
            <strong className="text-fg">{totalAuctions}</strong>{" "}
            {totalAuctions === 1 ? "auction" : "auctions"}
          </span>
          {activeAuctions > 0 && (
            <span>
              <strong className="text-fg">{activeAuctions}</strong>{" "}
              live
            </span>
          )}
        </div>

        <div className="flex items-center flex-wrap gap-2 pt-2">
          <a
            href={explorerAddressUrl(cfg.artistAddress)}
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs border border-gray-200 px-3 py-1.5 rounded-full hover:border-gray-400 transition-colors"
          >
            evm.now ↗
          </a>
          {house && (
            <a
              href={explorerAddressUrl(house)}
              target="_blank"
              rel="noopener noreferrer"
              title={house}
              className="inline-flex items-center gap-1.5 text-xs border border-gray-200 px-3 py-1.5 rounded-full hover:border-gray-400 transition-colors"
            >
              <span
                className="h-1.5 w-1.5 rounded-full bg-status-available"
                aria-hidden
              />
              <span>Auction house</span>
              <span className="font-mono text-gray-400">
                {formatAddress(house)}
              </span>
              <span aria-hidden>↗</span>
            </a>
          )}
          {links.map((url) => (
            <a
              key={url}
              href={url}
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs border border-gray-200 px-3 py-1.5 rounded-full hover:border-gray-400 transition-colors"
            >
              {prettyLinkLabel(url)} ↗
            </a>
          ))}
        </div>
      </div>
    </div>
  )
}

function prettyLinkLabel(url: string): string {
  try {
    const u = new URL(url)
    const host = u.hostname.replace(/^www\./, "")
    if (host === "x.com" || host === "twitter.com") {
      const handle = u.pathname.split("/").filter(Boolean)[0]
      if (handle) return `@${handle}`
    }
    return host
  } catch {
    return url
  }
}

/** Address-derived gradient (mirrors PND's `addressToColor`). */
function addressToColor(address: string, offset: number): string {
  const hex = address.slice(2, 8 + offset)
  const num = parseInt(hex, 16)
  const h = num % 360
  return `hsl(${h}, 60%, 70%)`
}
