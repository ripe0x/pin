import { ImageResponse } from "next/og"
import { getConfig } from "@/lib/config"
import {
  getArtistDisplayName,
  getArtistAvatarUrl,
  getArtistBio,
} from "@/lib/artist"

export const runtime = "nodejs"

export const alt = "Auctions"
export const size = { width: 1200, height: 630 }
export const contentType = "image/png"

/**
 * Index OG. Matches the PND palette: white surface, black text, gray
 * support copy, IBM Plex Mono for the metadata caption. Crawlers cache
 * unfurls aggressively so visual consistency with the site itself is
 * worth the duplicated style here.
 */
export default async function Image() {
  const cfg = getConfig()
  const [displayName, avatarUrl, bio] = await Promise.all([
    getArtistDisplayName(),
    getArtistAvatarUrl(),
    getArtistBio(),
  ])
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          padding: 80,
          background: "#FFFFFF",
          color: "#000000",
          fontFamily: "system-ui, sans-serif",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 24 }}>
          {avatarUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={avatarUrl}
              width={72}
              height={72}
              style={{ borderRadius: "100%", objectFit: "cover" }}
              alt=""
            />
          ) : (
            <div
              style={{
                width: 72,
                height: 72,
                borderRadius: "100%",
                background: `linear-gradient(135deg, ${addressToColor(cfg.artistAddress, 0)} 0%, ${addressToColor(cfg.artistAddress, 10)} 100%)`,
              }}
            />
          )}
          <div
            style={{
              fontSize: 36,
              fontWeight: 600,
              letterSpacing: -0.5,
              display: "flex",
            }}
          >
            {displayName}
          </div>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <div
            style={{
              fontSize: 120,
              fontWeight: 600,
              letterSpacing: -4,
              lineHeight: 1,
              display: "flex",
            }}
          >
            Auctions
          </div>
          {bio ? (
            <div
              style={{
                fontSize: 24,
                color: "#666666",
                maxWidth: 900,
                display: "flex",
              }}
            >
              {bio}
            </div>
          ) : (
            <div
              style={{
                fontSize: 14,
                color: "#999999",
                fontFamily: "monospace",
                textTransform: "uppercase",
                letterSpacing: 1.5,
                display: "flex",
              }}
            >
              On-chain · Sovereign auction house
            </div>
          )}
        </div>
      </div>
    ),
    { ...size },
  )
}

function addressToColor(address: string, offset: number): string {
  const hex = address.slice(2, 8 + offset)
  const num = parseInt(hex, 16)
  const h = num % 360
  return `hsl(${h}, 60%, 70%)`
}
