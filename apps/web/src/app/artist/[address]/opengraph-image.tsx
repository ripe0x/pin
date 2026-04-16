import { ImageResponse } from "next/og"
import { getArtistIdentity } from "@/lib/artist-queries"
import { discoverArtistTokens } from "@/lib/onchain-discovery"

export const runtime = "edge"
export const alt = "Artist portfolio on pin"
export const size = { width: 1200, height: 630 }
export const contentType = "image/png"

export default async function OGImage({
  params,
}: {
  params: Promise<{ address: string }>
}) {
  const { address } = await params

  const [identity, tokens] = await Promise.all([
    getArtistIdentity(address),
    discoverArtistTokens(address),
  ])

  // Get up to 4 artwork thumbnails
  const thumbnails = tokens
    .filter((t) => t.mediaHttpUrl)
    .slice(0, 4)
    .map((t) => t.mediaHttpUrl!)

  return new ImageResponse(
    (
      <div
        style={{
          display: "flex",
          width: "100%",
          height: "100%",
          backgroundColor: "#ffffff",
          fontFamily: "system-ui, sans-serif",
        }}
      >
        {/* Left side: artist info */}
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            justifyContent: "center",
            padding: "60px",
            width: "50%",
          }}
        >
          <div
            style={{
              display: "flex",
              width: "80px",
              height: "80px",
              borderRadius: "50%",
              background: `linear-gradient(135deg, hsl(${parseInt(address.slice(2, 8), 16) % 360}, 60%, 70%) 0%, hsl(${parseInt(address.slice(8, 14), 16) % 360}, 60%, 70%) 100%)`,
              marginBottom: "24px",
            }}
          />
          <div
            style={{
              fontSize: "40px",
              fontWeight: "700",
              letterSpacing: "-0.02em",
              marginBottom: "8px",
            }}
          >
            {identity.displayName}
          </div>
          <div
            style={{
              fontSize: "20px",
              color: "#666666",
            }}
          >
            {tokens.length} {tokens.length === 1 ? "work" : "works"} on
            Foundation
          </div>
          <div
            style={{
              fontSize: "16px",
              color: "#999999",
              marginTop: "24px",
            }}
          >
            pin
          </div>
        </div>

        {/* Right side: artwork grid */}
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            width: "50%",
            padding: "20px",
            gap: "8px",
          }}
        >
          {thumbnails.map((url, i) => (
            <div
              key={i}
              style={{
                display: "flex",
                width: thumbnails.length <= 1 ? "100%" : "calc(50% - 4px)",
                height: thumbnails.length <= 2 ? "100%" : "calc(50% - 4px)",
                overflow: "hidden",
              }}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={url}
                alt=""
                style={{
                  width: "100%",
                  height: "100%",
                  objectFit: "cover",
                }}
              />
            </div>
          ))}
          {thumbnails.length === 0 && (
            <div
              style={{
                display: "flex",
                width: "100%",
                height: "100%",
                backgroundColor: "#F2F2F2",
                alignItems: "center",
                justifyContent: "center",
                color: "#999999",
                fontSize: "20px",
              }}
            >
              No artwork available
            </div>
          )}
        </div>
      </div>
    ),
    { ...size },
  )
}
