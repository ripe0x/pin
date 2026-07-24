// Canvas rendering of one conveyor frame, shared by the GIF and MP4 exports.
//
// The conveyor is a pure function of (phase, palette, form), so an export doesn't screen-capture
// the live animation — it redraws each frame from the same math onto a canvas at export
// resolution. The loop is exact: the fill pattern repeats every n bands, so sampling phase
// p = k*n/F over F frames makes frame F wrap onto frame 0.
//
// GEOMETRY: the constants below mirror the live conveyor script in lib/homage/conveyor.ts (and
// its origin, the Homage site's lib/homage/conveyorScript.ts). Changing one without the others
// makes exports stop matching what the viewer saw.

const U = 240 // viewBox unit
const WO = 192 // outer field size
const AN = 6 // low-anchor numerator (y = AN*(U-s)/8)
const BMIN = -2 // bands below 0 are the clipped exit

/** One band of travel, in ms. The full loop is fills.length * PERIOD_MS. */
export const PERIOD_MS = 1400

export type ConveyorForm = {
  ground: string
  fills: string[]
  circle: boolean
}

/** Ground/fills/form from a static homage SVG, by the same detection the live conveyor uses:
 *  the width-only <rect> is the ground, every other shape is a ring fill (outer to inner), and
 *  any <circle> means the PFP form. Returns null when there's nothing to animate. */
export function parseConveyorForm(svg: string): ConveyorForm | null {
  const doc = new DOMParser().parseFromString(svg, "image/svg+xml")
  const shapes = [...doc.querySelectorAll("rect,circle")]
  let ground = "#000000"
  const fills: string[] = []
  let circle = false
  for (const e of shapes) {
    if (e.tagName === "rect" && e.getAttribute("x") === null) {
      ground = e.getAttribute("fill") ?? ground
    } else {
      const f = e.getAttribute("fill")
      if (f) fills.push(f)
      if (e.tagName === "circle") circle = true
    }
  }
  if (fills.length < 2) return null
  return {ground, fills, circle}
}

function sz(n: number, b: number): number {
  if (b >= n) return 0
  const w = (WO * (n - b)) / n
  return w < 0 ? 0 : w
}

/** Draw the frame at continuous phase p onto ctx, size x size px. */
export function drawFrame(
  ctx: CanvasRenderingContext2D,
  form: ConveyorForm,
  p: number,
  size: number,
) {
  const {ground, fills, circle} = form
  const n = fills.length
  const k = size / U // px per viewBox unit

  ctx.fillStyle = ground
  ctx.fillRect(0, 0, size, size)

  ctx.save()
  ctx.beginPath()
  if (circle) {
    ctx.arc((U / 2) * k, ((AN * (U - WO)) / 8 + WO / 2) * k, (WO / 2) * k, 0, Math.PI * 2)
  } else {
    const x = ((U - WO) / 2) * k
    const y = ((AN * (U - WO)) / 8) * k
    ctx.rect(Math.round(x), Math.round(y), Math.round(WO * k), Math.round(WO * k))
  }
  ctx.clip()

  // bands in [BMIN, n] at phase p, largest first so nested fills occlude correctly
  const hi = Math.floor(p)
  const lo = Math.ceil(p + BMIN - n)
  const rings: {s: number; color: string}[] = []
  for (let m = lo; m <= hi; m++) {
    const b = m - p + n
    if (b < BMIN || b > n) continue
    rings.push({s: sz(n, b), color: fills[((m % n) + n) % n]})
  }
  rings.sort((a, b) => b.s - a.s)
  for (const r of rings) {
    if (r.s <= 0) continue
    const x = ((U - r.s) / 2) * k
    const y = ((AN * (U - r.s)) / 8) * k
    ctx.fillStyle = r.color
    if (circle) {
      ctx.beginPath()
      ctx.arc(x + (r.s * k) / 2, y + (r.s * k) / 2, (r.s * k) / 2, 0, Math.PI * 2)
      ctx.fill()
    } else {
      // integer-snap the squares so their edges stay crisp at export scale
      ctx.fillRect(Math.round(x), Math.round(y), Math.round(r.s * k), Math.round(r.s * k))
    }
  }
  ctx.restore()
}

/** Progress readout shared by both encoders. */
export type ExportProgress = {frame: number; frames: number; px: number}

/** Yield to the event loop so a long encode doesn't lock the tab.
 *
 *  A MessageChannel, not requestAnimationFrame or setTimeout: rAF stops firing entirely in a
 *  hidden tab, which strands an in-flight export at whatever frame it was on, and background
 *  setTimeout is clamped to ~1s per call. Message tasks keep running at full speed. */
export function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => {
    const {port1, port2} = new MessageChannel()
    port1.onmessage = () => {
      port1.close()
      port2.close()
      resolve()
    }
    port2.postMessage(null)
  })
}
