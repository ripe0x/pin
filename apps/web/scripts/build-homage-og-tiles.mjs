// Offline build: compute the homage ring colors for a curated set of REAL CryptoPunks,
// so the OG share image shows actual punk homages (not invented ramps). Runs the same
// distill → rings pipeline as render.ts on the punks SDK's bundled pixels, and writes a
// small JSON the edge OG route imports (no SDK at runtime).
//
// Run: node apps/web/scripts/build-homage-og-tiles.mjs
// Writes: apps/web/src/app/collections/homage/og-tiles.json

import {writeFileSync} from "node:fs"
import {createPunksSdk} from "@networked-art/punks-sdk"
import {bundledOfflinePunksDataWithPixels} from "@networked-art/punks-sdk/offline-pixel-data"

const sdk = createPunksSdk({dataset: bundledOfflinePunksDataWithPixels})
const ds = sdk.dataset

// palette id -> {r,g,b,a}
const palById = []
for (const e of ds.palette()) palById[e.id] = e

// ---- render.ts port (distill + rings), byte-faithful ----
const MERGE_T = 24
const W_OUTER = 192
const MAX_RINGS = 19
const W_CHROMA = 7
const W_RARITY = 3
const r8 = (c) => (c >> 16) & 0xff
const g8 = (c) => (c >> 8) & 0xff
const b8 = (c) => c & 0xff
const dist = (a, b) => Math.abs(r8(a) - r8(b)) + Math.abs(g8(a) - g8(b)) + Math.abs(b8(a) - b8(b))
const lum = (c) => r8(c) + g8(c) + b8(c)
const hex = (c) => "#" + (c >>> 0).toString(16).padStart(6, "0")

function pixels(id) {
  const idx = ds.indexedPixels(id)
  const img = new Uint8Array(2304)
  for (let p = 0; p < 576; p++) {
    const e = palById[idx[p]]
    const o = p * 4
    img[o] = e.r
    img[o + 1] = e.g
    img[o + 2] = e.b
    img[o + 3] = e.a
  }
  return img
}

function distill(img) {
  const col = [], cnt = []
  let n = 0
  for (let p = 0; p < 576; p++) {
    const o = p * 4
    if (img[o + 3] < 128) continue
    const rgb = (img[o] << 16) | (img[o + 1] << 8) | img[o + 2]
    let f = n
    for (let k = 0; k < n; k++) if (col[k] === rgb) { f = k; break }
    if (f === n) { col[n] = rgb; cnt[n] = 1; n++ } else cnt[f]++
  }
  const ord = []
  for (let i = 0; i < n; i++) ord[i] = i
  for (let i = 1; i < n; i++) {
    const v = ord[i]
    let j = i
    while (j > 0 && cnt[ord[j - 1]] < cnt[v]) { ord[j] = ord[j - 1]; j-- }
    ord[j] = v
  }
  const mc = [], mn = [], used = new Array(n).fill(false)
  let m = 0
  for (let a = 0; a < n; a++) {
    const i = ord[a]
    if (used[i]) continue
    let c = cnt[i]
    for (let b = a + 1; b < n; b++) {
      const j = ord[b]
      if (!used[j] && dist(col[i], col[j]) < MERGE_T) { used[j] = true; c += cnt[j] }
    }
    mc[m] = col[i]; mn[m] = c; m++
  }
  const gone = new Array(m).fill(false)
  let liveN = m
  while (liveN > MAX_RINGS) {
    let bi = 0, bj = 0, bestD = Infinity
    for (let i = 0; i < m; i++) {
      if (gone[i]) continue
      for (let j = i + 1; j < m; j++) {
        if (gone[j]) continue
        const dd = dist(mc[i], mc[j])
        if (dd < bestD) { bestD = dd; bi = i; bj = j }
      }
    }
    if (mn[bi] < mn[bj]) { const t = bi; bi = bj; bj = t }
    mn[bi] += mn[bj]; gone[bj] = true; liveN--
  }
  const cols = [], cnts = []
  for (let i = 0; i < m; i++) if (!gone[i]) { cols.push(mc[i]); cnts.push(mn[i]) }
  return {cols, cnts}
}

function rings(cols, cnts) {
  const m = cols.length
  if (m === 0) return []
  if (m === 1) return [cols[0]]
  let maxCnt = 1
  for (let i = 0; i < m; i++) if (cnts[i] > maxCnt) maxCnt = cnts[i]
  let bestAcc = 0, acc = 0
  for (let i = 0; i < m; i++) {
    const c = cols[i], r = r8(c), g = g8(c), b = b8(c)
    let mx = r; if (g > mx) mx = g; if (b > mx) mx = b
    let mnv = r; if (g < mnv) mnv = g; if (b < mnv) mnv = b
    const score = (mx - mnv) * W_CHROMA + (255 - Math.floor((cnts[i] * 255) / maxCnt)) * W_RARITY
    if (score > bestAcc) { bestAcc = score; acc = i }
  }
  let dom = acc === 0 ? 1 : 0
  for (let i = 0; i < m; i++) { if (i === acc) continue; if (cnts[i] > cnts[dom]) dom = i }
  const mid = []
  for (let i = 0; i < m; i++) if (i !== dom && i !== acc) mid.push(i)
  const asc = lum(cols[dom]) <= lum(cols[acc])
  for (let i = 1; i < mid.length; i++) {
    const v = mid[i], lv = lum(cols[v])
    let j = i
    while (j > 0 && (asc ? lum(cols[mid[j - 1]]) > lv : lum(cols[mid[j - 1]]) < lv)) { mid[j] = mid[j - 1]; j-- }
    mid[j] = v
  }
  const order = [cols[dom]]
  for (let i = 0; i < mid.length; i++) order.push(cols[mid[i]])
  order.push(cols[acc])
  return order
}

const homageRings = (id) => {
  const {cols, cnts} = distill(pixels(id))
  return rings(cols, cnts).map(hex)
}

// ---- curated selection: rare types for distinctive color + a spread of regulars ----
const first = (name, k) => ds.search({attributes: {required: [name]}}).slice(0, k)
const picks = [
  ...first("Alien", 1),
  ...first("Ape", 1),
  ...first("Zombie", 2),
]
for (let id = 250; picks.length < 18; id += 517) if (!picks.includes(id)) picks.push(id)

const tiles = picks.slice(0, 18).map((id) => ({id, rings: homageRings(id)}))
const url = new URL("../src/app/collections/homage/og-tiles.json", import.meta.url)
writeFileSync(url, JSON.stringify(tiles))
console.log(
  `wrote ${url.pathname}: ${tiles.length} real-punk tiles ` +
    `(ids ${tiles.map((t) => t.id).join(", ")})`,
)
