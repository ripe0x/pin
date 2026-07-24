// Animated-GIF export of the conveyor: a perfect loop, encoded in the browser from the frame math
// in conveyor-frames.ts. Ported from the Homage site's lib/homage/conveyorGif.ts.
//
// GIF is the pixel-exact export: a homage is under a dozen flat colors, well inside the 256-entry
// palette, so quantization is lossless here. Size budget aims as high-res as fits the byte cap,
// stepping down through EXPORT_SIZES until the encoded blob fits; flat color LZW-compresses well,
// so the top size usually wins.

import {GIFEncoder, quantize, applyPalette} from "gifenc"
import {
  drawFrame,
  parseConveyorForm,
  type ExportProgress,
  PERIOD_MS,
  yieldToEventLoop,
} from "./conveyor-frames"

const EXPORT_SIZES = [1440, 1200, 960, 720]
const MAX_FRAMES = 240 // caps encode time + size; delay stretches for many-color punks

export async function generateConveyorGif(
  svg: string,
  opts: {maxBytes?: number; onProgress?: (p: ExportProgress) => void} = {},
): Promise<{blob: Blob; px: number; frames: number; delayMs: number} | null> {
  const form = parseConveyorForm(svg)
  if (!form) return null
  const maxBytes = opts.maxBytes ?? 15 * 1024 * 1024

  const n = form.fills.length
  const loopMs = n * PERIOD_MS
  // GIF delays are 10ms units; pick the smoothest delay that keeps F <= MAX_FRAMES
  const delayMs = Math.max(40, Math.ceil(loopMs / MAX_FRAMES / 10) * 10)
  const frames = Math.round(loopMs / delayMs)

  const canvas = document.createElement("canvas")

  for (const px of EXPORT_SIZES) {
    canvas.width = canvas.height = px
    const ctx = canvas.getContext("2d", {willReadFrequently: true})
    if (!ctx) throw new Error("no 2d context")

    // one shared palette from a mid-loop frame (has every fill + edge blends)
    drawFrame(ctx, form, (0.5 * n) / frames + n / 2, px)
    const sample = ctx.getImageData(0, 0, px, px).data
    const palette = quantize(sample, 256)

    const gif = GIFEncoder()
    for (let i = 0; i < frames; i++) {
      drawFrame(ctx, form, (i * n) / frames, px)
      const {data} = ctx.getImageData(0, 0, px, px)
      gif.writeFrame(applyPalette(data, palette), px, px, {
        palette,
        delay: delayMs,
        repeat: 0, // loop forever
      })
      opts.onProgress?.({frame: i + 1, frames, px})
      if (i % 8 === 7) await yieldToEventLoop() // keep the UI alive
    }
    gif.finish()

    const bytes = gif.bytes()
    if (bytes.byteLength <= maxBytes) {
      // copy into a fresh ArrayBuffer-backed view (TS: BlobPart wants ArrayBuffer, not ArrayBufferLike)
      return {blob: new Blob([new Uint8Array(bytes)], {type: "image/gif"}), px, frames, delayMs}
    }
    // too big — try the next size down
  }
  throw new Error("could not fit the GIF under the size cap")
}
