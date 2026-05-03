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
              fontSize: 88,
              fontWeight: 600,
              letterSpacing: -3,
              lineHeight: 1.05,
              display: "flex",
            }}
          >
            Run your own auctions,
            <br />
            on your own url.
          </div>
          <div
            style={{
              fontFamily: "monospace",
              fontSize: 32,
              fontWeight: 500,
              color: "#374151",
              display: "flex",
              flexDirection: "column",
              gap: 2,
              lineHeight: 1.3,
            }}
          >
            <span>your work.</span>
            <span>your contracts.</span>
            <span>your fees.</span>
            <span>now, your url.</span>
          </div>
        </div>
      </div>
    ),
    { ...size },
  )
}
