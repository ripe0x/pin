import { ImageResponse } from "next/og"
import { resolveMintCollection } from "@/lib/mint-collections"

/**
 * Per-token social card for `/mint/[contract]/[tokenId]`.
 *
 * OG approach (deliberate): a TYPOGRAPHIC card, not the token art. The art is a
 * fully-onchain SVG data-URI, and satori (what `next/og` runs under) can't
 * rasterize an arbitrary `<img src="data:image/svg+xml…">` reliably — it drops
 * or mis-renders most nontrivial SVGs. The alternatives were adding
 * `@resvg/resvg-js` to rasterize the SVG (a new native dep the repo doesn't
 * otherwise use, and heavier on Netlify's function runtime) — not worth it for
 * a social card. This route needs no rasterization, no RPC, and no indexer, so
 * it's robust on Netlify's runtime and works pre-deploy. Collection name + id +
 * "Fully onchain" is the honest, always-available summary.
 */

export const runtime = "nodejs"
export const alt = "Homage token"
export const size = { width: 1200, height: 630 }
export const contentType = "image/png"

export default async function Image({
  params,
}: {
  params: { contract: string; tokenId: string }
}) {
  const desc = resolveMintCollection(params.contract)
  const name = desc?.name ?? "Mint"
  const noun = desc?.tokenNoun ?? "token"
  const tokenId = /^\d+$/.test(params.tokenId) ? params.tokenId : ""

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
          {name}
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
          <div
            style={{
              fontSize: 132,
              fontWeight: 700,
              letterSpacing: -4,
              lineHeight: 1,
              display: "flex",
            }}
          >
            {tokenId ? `${cap(noun)} #${tokenId}` : name}
          </div>
          <div
            style={{
              fontFamily: "monospace",
              fontSize: 30,
              fontWeight: 500,
              color: "#374151",
              display: "flex",
            }}
          >
            Fully onchain · ERC-721
          </div>
        </div>
      </div>
    ),
    { ...size },
  )
}

function cap(s: string): string {
  return s.length > 0 ? s[0].toUpperCase() + s.slice(1) : s
}
