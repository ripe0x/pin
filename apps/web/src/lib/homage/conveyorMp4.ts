// MP4 export of the conveyor, encoded in the browser from the frame math in conveyor-frames.ts.
//
// Same deterministic loop as the GIF, encoded as H.264 through WebCodecs (via mediabunny) instead
// of screen-recorded, so frame timing is exact and it runs faster than realtime. The result is a
// fraction of the GIF's bytes at a higher resolution and framerate, and MP4 is the format the
// social platforms accept.
//
// H.264 is 4:2:0, so the saturated ring edges carry a faint chroma softening the GIF doesn't have.
// The bitrate below is set high enough that it doesn't read on flat color. GIF remains the
// pixel-exact export; this one is the small, smooth, shareable one.
//
// WebCodecs video encoding is unavailable on older browsers — call `canExportMp4()` and hide the
// entry point rather than letting the export throw.

import {drawFrame, parseConveyorForm, type ExportProgress, PERIOD_MS} from "./conveyor-frames"

const EXPORT_PX = 1080 // must stay even: H.264 chroma planes are half-resolution
const FPS = 30

/** Whether this browser can encode the MP4 at export settings. */
export async function canExportMp4(): Promise<boolean> {
  if (typeof window === "undefined" || typeof VideoEncoder === "undefined") return false
  try {
    const {canEncodeVideo} = await import("mediabunny")
    return await canEncodeVideo("avc", {width: EXPORT_PX, height: EXPORT_PX})
  } catch {
    return false
  }
}

export async function generateConveyorMp4(
  svg: string,
  opts: {onProgress?: (p: ExportProgress) => void} = {},
): Promise<{blob: Blob; px: number; frames: number; fps: number} | null> {
  const form = parseConveyorForm(svg)
  if (!form) return null

  const {BufferTarget, CanvasSource, Mp4OutputFormat, Output, QUALITY_HIGH} = await import(
    "mediabunny"
  )

  const n = form.fills.length
  const loopSec = (n * PERIOD_MS) / 1000
  const frames = Math.round(loopSec * FPS)
  const frameDur = 1 / FPS

  const canvas = document.createElement("canvas")
  canvas.width = canvas.height = EXPORT_PX
  const ctx = canvas.getContext("2d")
  if (!ctx) throw new Error("no 2d context")

  const output = new Output({
    format: new Mp4OutputFormat({fastStart: "in-memory"}), // moov up front, so it streams on the web
    target: new BufferTarget(),
  })
  const source = new CanvasSource(canvas, {codec: "avc", bitrate: QUALITY_HIGH})
  output.addVideoTrack(source, {frameRate: FPS})

  await output.start()
  for (let i = 0; i < frames; i++) {
    drawFrame(ctx, form, (i * n) / frames, EXPORT_PX)
    // awaited so the encoder's backpressure paces the loop instead of queueing every frame at once
    await source.add(i * frameDur, frameDur)
    opts.onProgress?.({frame: i + 1, frames, px: EXPORT_PX})
  }
  await output.finalize()

  const buffer = output.target.buffer
  if (!buffer) throw new Error("MP4 encode produced no output")
  return {blob: new Blob([buffer], {type: "video/mp4"}), px: EXPORT_PX, frames, fps: FPS}
}
