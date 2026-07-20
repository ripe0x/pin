import {ImageResponse} from "next/og"

// Share graphic for the pre-deploy /collections/homage landing: a uniform quilt of
// Albers homage tiles, no text. Post-launch the beforeFiles rewrite serves the live
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

// Representative homages (ground + outer→inner ring colors), drawn from the real
// punk palette — one per cell, hand-composed so the card needs no data dependency.
const HOMAGES: {ground: string; rings: string[]}[] = [
  {ground: "#6a8494", rings: ["#000000", "#6a563f", "#8b6d4e", "#b89b74", "#d8c4a0", "#e8b84b"]},
  {ground: "#75a475", rings: ["#000000", "#2f4a2f", "#5e7253", "#7da269", "#a8c49a", "#ff5533"]},
  {ground: "#8970b1", rings: ["#000000", "#141a3a", "#142c7c", "#1a43c8", "#6a8cd8", "#f2f2f2"]},
  {ground: "#8c5851", rings: ["#000000", "#3a1a44", "#8119b7", "#b261dc", "#d8a0e8", "#ffd21f"]},
  {ground: "#5f7d8c", rings: ["#000000", "#352410", "#6a563f", "#a98c6b", "#d8c4a0", "#4169e1"]},
  {ground: "#6a8494", rings: ["#000000", "#3a2f2f", "#8c5851", "#c07a5b", "#e0a878", "#f5e6c8"]},
  {ground: "#75a475", rings: ["#000000", "#1a3a1a", "#2f6a2f", "#5e9e5e", "#a8d8a8", "#ffd21f"]},
  {ground: "#8970b1", rings: ["#000000", "#2a1a4a", "#5a3a8a", "#8c5db8", "#c8a0e0", "#ff5533"]},
  {ground: "#8c5851", rings: ["#000000", "#2f2f4a", "#3a5a9e", "#6a8cd8", "#a8c4e8", "#ffffff"]},
  {ground: "#5f7d8c", rings: ["#000000", "#4a3a1a", "#8b6d2e", "#c8a860", "#e8d8a0", "#e05050"]},
  {ground: "#6a8494", rings: ["#000000", "#1a1a1a", "#4a4a4a", "#8a8a8a", "#c8c8c8", "#e8b84b"]},
  {ground: "#8970b1", rings: ["#000000", "#c8fbfb", "#9be0e0", "#75bdbd", "#4a9a9a", "#1a43c8"]},
  {ground: "#8c5851", rings: ["#000000", "#5e7253", "#7da269", "#a8c49a", "#d8e8c8", "#ff0000"]},
  {ground: "#75a475", rings: ["#000000", "#3a2a1a", "#6a4a2a", "#a8784a", "#d8b088", "#4169e1"]},
  {ground: "#5f7d8c", rings: ["#000000", "#2a2a3a", "#4a4a6a", "#7a7a9a", "#b0b0c8", "#ff5533"]},
  {ground: "#6a8494", rings: ["#000000", "#3a3a1a", "#7a6a2a", "#b8a04a", "#e0d080", "#8119b7"]},
  {ground: "#75a475", rings: ["#000000", "#3a1a1a", "#7a3a2a", "#b86a4a", "#e0a878", "#ffd21f"]},
  {ground: "#8970b1", rings: ["#000000", "#1a3a3a", "#2a6a6a", "#4a9a9a", "#8ac8c8", "#e05050"]},
]

// One homage as nested squares, anchored low (the on-chain svg()'s geometry: UNIT
// 240, W_OUTER 192, ANCHOR 6), at TILE px.
function Tile({h}: {h: {ground: string; rings: string[]}}) {
  const f = TILE / 240
  const n = h.rings.length
  return (
    <div style={{position: "relative", width: TILE, height: TILE, backgroundColor: TEAL, display: "flex"}}>
      {h.rings.map((c, k) => {
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
              return <Tile key={c} h={HOMAGES[i % HOMAGES.length]} />
            })}
          </div>
        ))}
      </div>
    ),
    {...size},
  )
}
