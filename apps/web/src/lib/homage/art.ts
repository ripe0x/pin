// Client-side homage art transforms for the token detail stage — the subset of the
// Homage site's lib/homageGeom.ts + lib/png.ts the detail page uses (port source:
// permanence web/lib/homageGeom.ts `parseHomage`/`pfpSvg`, web/lib/png.ts).

import {svgToSrc} from "@/components/mint/homage-gallery/svg"

export type Shape = {x: number; y: number; s: number; fill: string}

/** Decode a homage image src (bare SVG, or a data URI, base64 or utf8) to the raw SVG string. */
export function decodeSvg(src: string): string | null {
  const b = src.indexOf(";base64,")
  const u = src.indexOf(";utf8,")
  try {
    if (b >= 0) return atob(src.slice(b + 8))
    if (u >= 0) return decodeURIComponent(src.slice(u + 6))
  } catch {
    return null
  }
  return src.startsWith("<svg") ? src : null
}

/** Pull the ground fill + nested squares (x, y, side, fill) out of a homage SVG. */
export function parseHomage(src: string): {ground: string; rects: Shape[]} | null {
  const svg = decodeSvg(src)
  if (!svg) return null
  const rects: Shape[] = []
  let ground = "#000000"
  const re = /<rect\s+(?:x="(\d+)"\s+y="(\d+)"\s+)?width="(\d+)"\s+height="(\d+)"\s+fill="(#[0-9a-fA-F]{3,8})"\s*\/>/g
  let m: RegExpExecArray | null
  while ((m = re.exec(svg)) !== null) {
    if (m[1] === undefined) ground = m[5] // the ground rect has no x/y
    else rects.push({x: +m[1], y: +m[2], s: +m[3], fill: m[5]})
  }
  return rects.length ? {ground, rects} : null
}

const UNIT = 240

/** PFP treatment: the classic nest's squares replaced by their inscribed circles — each
 *  rect (x, y, s) becomes a circle at (x+s/2, y+s/2) with radius s/2. Same ground, colors,
 *  and stacking order; only the primitive changes. Reuses the already-fetched homage SVG
 *  (no extra RPC). Returns null if it can't be parsed.
 *
 *  CANONICAL FORM: `HomageRenderer.renderSVG(id, status, true)` on-chain. The renderer
 *  forces even side lengths, so the center and radius are exact integers and this mirror
 *  is byte-shaped like the contract output (circle form drops shape-rendering=crispEdges
 *  so the curves anti-alias). */
export function pfpSvg(deployedSvg: string): string | null {
  const parsed = parseHomage(deployedSvg)
  if (!parsed || parsed.rects.length === 0) return null
  let inner = ""
  for (const r of parsed.rects) {
    const radius = r.s / 2
    inner += `<circle cx="${r.x + radius}" cy="${r.y + radius}" r="${radius}" fill="${r.fill}"/>`
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${UNIT} ${UNIT}"><rect width="${UNIT}" height="${UNIT}" fill="${parsed.ground}"/>${inner}</svg>`
}

/** `<img>`-ready src for a bare SVG string. */
export const pfpSrc = (deployedSvg: string): string | null => {
  const svg = pfpSvg(deployedSvg)
  return svg ? svgToSrc(svg) : null
}

/** Inject an explicit pixel width/height onto the root <svg>, replacing any existing ones.
 *  The renderer's raw SVG carries only a viewBox — no intrinsic size — so an <img> pointed
 *  at it gets the browser's tiny default natural size (300×150-ish). That's what a
 *  right-click "copy image" / "save image as" / drag-out rasterizes at, regardless of the
 *  on-screen CSS display size. Stamping a real width/height fixes the intrinsic size the
 *  browser reports, so those native, button-free actions produce a full-resolution image. */
export function sizedSvg(raw: string, size: number): string {
  return raw.replace(/<svg([^>]*)>/, (_m, attrs: string) => {
    const cleaned = attrs.replace(/\s(width|height)="[^"]*"/g, "")
    return `<svg${cleaned} width="${size}" height="${size}">`
  })
}

/** `<img>`-ready src for an SVG string, stamped to `size`×`size` (see `sizedSvg`). */
export function sizedSvgSrc(raw: string, size: number): string {
  return svgToSrc(sizedSvg(raw, size))
}

/** Rasterize an SVG string to a PNG Blob at `size`×`size`. imageSmoothingEnabled=false
 *  keeps the hard Albers edges crisp. */
export function svgToPngBlob(raw: string, size: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => {
      const c = document.createElement("canvas")
      c.width = c.height = size
      const ctx = c.getContext("2d")
      if (!ctx) return reject(new Error("no 2d context"))
      ctx.imageSmoothingEnabled = false
      ctx.drawImage(img, 0, 0, size, size)
      c.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("toBlob failed"))), "image/png")
    }
    img.onerror = () => reject(new Error("svg failed to load for rasterization"))
    img.src = sizedSvgSrc(raw, size)
  })
}

const COMPARE_BG = "#e8e8e8" // ripe-bot's light field (see gridComposite.ts / ripeGridOptions)

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error("image failed to load"))
    img.src = src
  })
}

/** Side-by-side punk + homage composite PNG at `tile`×`tile` per side, on a light field — same
 *  look as the permanence repo's offline compare-gif script (generate-pair-gif.mjs), but a
 *  single static pair instead of a cycling animation, so it's plain Canvas here (no sharp/gifenc,
 *  which don't run in a browser). */
export async function compositePairPngBlob({
  punkSvg,
  homageSvg,
  ground,
  tile = 1000,
}: {
  punkSvg: string
  homageSvg: string
  ground: string
  tile?: number
}): Promise<Blob> {
  const pad = Math.round(tile * 0.14)
  const gap = Math.round(tile * 0.06)

  const [punkImg, homageImg] = await Promise.all([
    loadImage(sizedSvgSrc(punkSvg, tile)),
    loadImage(sizedSvgSrc(homageSvg, tile)),
  ])

  const width = pad * 2 + tile * 2 + gap
  const height = pad * 2 + tile
  const c = document.createElement("canvas")
  c.width = width
  c.height = height
  const ctx = c.getContext("2d")
  if (!ctx) throw new Error("no 2d context")
  ctx.imageSmoothingEnabled = false

  ctx.fillStyle = COMPARE_BG
  ctx.fillRect(0, 0, width, height)

  const drawTile = (img: HTMLImageElement, x: number) => {
    ctx.fillStyle = ground
    ctx.fillRect(x, pad, tile, tile)
    ctx.drawImage(img, x, pad, tile, tile)
  }
  drawTile(punkImg, pad)
  drawTile(homageImg, pad + tile + gap)

  return new Promise((resolve, reject) => {
    c.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("toBlob failed"))), "image/png")
  })
}

export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement("a")
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 3000)
}
