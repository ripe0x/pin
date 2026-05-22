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
import { formatAddress } from "@/lib/format"
import { getEnsName } from "@/lib/ens"
import { AddressZorb } from "@/components/AddressZorb"
import { CopyAddressButton } from "@/components/CopyAddressButton"

type Props = {
  totalAuctions: number
  activeAuctions: number
}

export async function ArtistHero({ totalAuctions, activeAuctions }: Props) {
  const cfg = getConfig()
  const [displayName, avatarUrl, bio, links, ens] = await Promise.all([
    getArtistDisplayName(),
    getArtistAvatarUrl(),
    getArtistBio(),
    getArtistLinks(),
    getEnsName(cfg.artistAddress),
  ])
  const showAddressUnderName = !!ens || !!cfg.artistName
  const evmNowUrl = `https://evm.now/address/${cfg.artistAddress}`
  const truncatedAddress = formatAddress(cfg.artistAddress)

  return (
    <div className="flex flex-col sm:flex-row items-start sm:items-center gap-6">
      {avatarUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={avatarUrl}
          alt={displayName}
          className="h-20 w-20 shrink-0 rounded-full object-cover"
        />
      ) : (
        <AddressZorb
          address={cfg.artistAddress}
          className="h-20 w-20 shrink-0 rounded-full"
        />
      )}

      <div className="space-y-3 min-w-0">
        {showAddressUnderName ? (
          <div className="space-y-1">
            <h1 className="text-base font-mono font-medium tracking-tight truncate">
              {displayName}
            </h1>
            <div className="flex items-center gap-2">
              <a
                href={evmNowUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="font-mono text-[11px] text-gray-500 hover:text-fg transition-colors"
              >
                {truncatedAddress}
              </a>
              <CopyAddressButton address={cfg.artistAddress} />
            </div>
          </div>
        ) : (
          <div className="flex items-center gap-2 min-w-0">
            <h1 className="text-base font-mono font-medium tracking-tight truncate min-w-0">
              <a
                href={evmNowUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="hover:text-gray-500 transition-colors"
              >
                {displayName}
              </a>
            </h1>
            <CopyAddressButton address={cfg.artistAddress} />
          </div>
        )}
        {bio ? (
          <p className="max-w-2xl text-sm text-fg-muted">{bio}</p>
        ) : null}

        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] font-mono text-gray-500">
          <span>
            <strong className="font-medium text-fg">{totalAuctions}</strong>{" "}
            {totalAuctions === 1 ? "auction" : "auctions"}
          </span>
          {activeAuctions > 0 && (
            <>
              <span aria-hidden className="text-gray-300">
                ·
              </span>
              <span>
                <strong className="font-medium text-fg">{activeAuctions}</strong>{" "}
                live
              </span>
            </>
          )}
        </div>

        {links.length > 0 && (
          <div className="flex items-center flex-wrap gap-2">
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
        )}
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

