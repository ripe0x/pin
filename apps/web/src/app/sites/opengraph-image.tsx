import { ImageResponse } from "next/og"
import { SITE_TITLE } from "@pin/shared"

export const runtime = "nodejs"
export const alt = "Run your own auction page"
export const size = { width: 1200, height: 630 }
export const contentType = "image/png"

export default async function Image() {
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
        <div
          style={{
            fontSize: 14,
            fontFamily: "monospace",
            textTransform: "uppercase",
            letterSpacing: 1.5,
            color: "#666666",
            display: "flex",
          }}
        >
          {SITE_TITLE} · Sites
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
          <div
            style={{
              fontSize: 110,
              fontWeight: 600,
              letterSpacing: -4,
              lineHeight: 1,
              display: "flex",
            }}
          >
            Run your own
            <br />
            auction page.
          </div>
          <div
            style={{
              fontSize: 26,
              color: "#666666",
              maxWidth: 900,
              display: "flex",
              lineHeight: 1.4,
            }}
          >
            A free, self-hosted page that reads your Sovereign auction house
            contract directly. Active auctions, past sales, and in-page
            bidding, on your own domain.
          </div>
        </div>
      </div>
    ),
    { ...size },
  )
}
