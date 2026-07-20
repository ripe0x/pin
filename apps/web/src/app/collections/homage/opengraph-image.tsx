import {ImageResponse} from "next/og"
// Homage ring colors for 18 real CryptoPunks (their actual distill→rings output),
// precomputed by scripts/build-homage-og-tiles.mjs so the edge route needs no SDK.
import ogTiles from "./og-tiles.json"

// Share graphic for the pre-deploy /collections/homage landing: a uniform quilt of
// real punk homages, no text. Post-launch the beforeFiles rewrite serves the live
// /collections/<address> page, which supplies its own OG.
//
// Perfect fit: a 6×3 grid of equal 178px squares with 12px gaps and a 36px margin
// tiles 1200×630 exactly — 36·2 + 6·178 + 5·12 = 1200, 36·2 + 3·178 + 2·12 = 630 —
// so every cell is a complete square with none clipped or half-empty.

export const runtime = "edge"
export const alt = "Homage to the Punk"
export const size = {width: 1200, height: 630}
export const contentType = "image/png"

const COLS = 6
const ROWS = 3
const TILE = 178
const GAP = 12
const MARGIN = 36
// The CryptoPunks background teal — cryptopunks.app's actual rendered ground, verified
// live as rgb(99,133,150). (The onchain homage ground is a near-identical #6a8494; this
// uses the true punk value.) Reused for the gaps + margin so the field is seamless — the
// tiles read as motifs floating on one continuous plane.
const TEAL = "#638596"

// One homage as nested squares, anchored low (the on-chain svg()'s geometry: UNIT
// 240, W_OUTER 192, ANCHOR 6), at TILE px. `rings` are a real punk's homage colors.
function Tile({rings}: {rings: string[]}) {
  const f = TILE / 240
  const n = rings.length
  return (
    <div style={{position: "relative", width: TILE, height: TILE, backgroundColor: TEAL, display: "flex"}}>
      {rings.map((c, k) => {
        let w = Math.floor((192 * (n - k)) / n)
        w -= w & 1
        const x = (240 - w) / 2
        const y = Math.floor((6 * (240 - w)) / 8)
        return (
          <div
            key={k}
            style={{position: "absolute", left: x * f, top: y * f, width: w * f, height: w * f, backgroundColor: c}}
          />
        )
      })}
    </div>
  )
}

export default function OGImage() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          backgroundColor: TEAL,
          display: "flex",
          flexDirection: "column",
          padding: MARGIN,
          gap: GAP,
        }}
      >
        {Array.from({length: ROWS}, (_, r) => (
          <div key={r} style={{display: "flex", gap: GAP}}>
            {Array.from({length: COLS}, (_, c) => {
              const i = r * COLS + c
              return <Tile key={c} rings={ogTiles[i % ogTiles.length].rings} />
            })}
          </div>
        ))}
      </div>
    ),
    {...size},
  )
}
