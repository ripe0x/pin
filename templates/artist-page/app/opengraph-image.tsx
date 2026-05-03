import { ImageResponse } from "next/og"
import { getConfig } from "@/lib/config"
import { getArtistDisplayName } from "@/lib/artist"

// Note: this used to be the edge runtime, but resolving the artist name
// via ENS goes through our viem client + server-only config — both Node
// APIs. Edge cold-starts wouldn't matter for an OG endpoint anyway.
export const runtime = "nodejs"

export const alt = "Auctions"
export const size = { width: 1200, height: 630 }
export const contentType = "image/png"

export default async function Image() {
  const cfg = getConfig()
  const displayName = await getArtistDisplayName()
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
          background: "linear-gradient(135deg, #0a0a0a 0%, #1a1a1a 100%)",
          color: "#fafafa",
          fontFamily: "system-ui, sans-serif",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 24 }}>
          {cfg.artistAvatarUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={cfg.artistAvatarUrl}
              width={96}
              height={96}
              alt=""
            />
          ) : (
            <div
              style={{
                width: 96,
                height: 96,
                background: "#262626",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontSize: 48,
                fontWeight: 600,
              }}
            >
              {displayName.charAt(0).toUpperCase()}
            </div>
          )}
          <div
            style={{
              fontSize: 56,
              fontWeight: 600,
              letterSpacing: -1,
              display: "flex",
            }}
          >
            {displayName}
          </div>
        </div>
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 12,
          }}
        >
          <div
            style={{
              fontSize: 96,
              fontWeight: 700,
              letterSpacing: -3,
              lineHeight: 1,
              display: "flex",
            }}
          >
            Auctions
          </div>
          {cfg.artistBio ? (
            <div
              style={{
                fontSize: 28,
                color: "#a3a3a3",
                maxWidth: 900,
                display: "flex",
              }}
            >
              {cfg.artistBio}
            </div>
          ) : null}
        </div>
      </div>
    ),
    { ...size },
  )
}
