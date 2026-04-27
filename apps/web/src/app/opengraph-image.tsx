import { ImageResponse } from "next/og"
import { SITE_TITLE, SITE_DESCRIPTION } from "@pin/shared"

export const runtime = "edge"
export const alt = SITE_TITLE
export const size = { width: 1200, height: 630 }
export const contentType = "image/png"

export default function OGImage() {
  return new ImageResponse(
    (
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          width: "100%",
          height: "100%",
          backgroundColor: "#ffffff",
          color: "#000000",
          padding: "80px",
          justifyContent: "space-between",
          fontFamily: "system-ui, sans-serif",
        }}
      >
        <div
          style={{
            fontSize: "180px",
            fontWeight: 700,
            letterSpacing: "-0.04em",
            lineHeight: 1,
          }}
        >
          {SITE_TITLE}
        </div>
        <div
          style={{
            fontSize: "32px",
            color: "#666666",
            maxWidth: "900px",
            lineHeight: 1.3,
          }}
        >
          {SITE_DESCRIPTION}
        </div>
      </div>
    ),
    { ...size },
  )
}
