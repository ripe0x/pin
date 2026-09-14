/**
 * Headless-Chromium capture of one token's opening frame, via Playwright.
 * frame.html + anton.js (or any Surface work following the same
 * injection-convention document) draw once, synchronously, when loaded with
 * `context=capture` -- no animation loop to race against.
 */
import { chromium, type Browser } from "playwright"
import { sha256Hex } from "./hash.ts"

const VIEWPORT = 2048

export interface RenderTarget {
  frameBaseUrl: string
  seed: `0x${string}`
  owner: `0x${string}`
}

/**
 * Chromium launch args enabling software WebGL under headless Playwright.
 * Different Chromium builds accept different SwiftShader flag spellings;
 * try the ANGLE/SwiftShader pair first, fall back to the unsafe-swiftshader
 * flag. Returns which set actually worked so the caller can report it.
 */
const LAUNCH_ARG_CANDIDATES: string[][] = [
  ["--force-color-profile=srgb", "--use-gl=angle", "--use-angle=swiftshader"],
  ["--force-color-profile=srgb", "--enable-unsafe-swiftshader"],
]

export async function launchCaptureBrowser(): Promise<{ browser: Browser; args: string[] }> {
  let lastErr: unknown
  for (const args of LAUNCH_ARG_CANDIDATES) {
    try {
      const browser = await chromium.launch({ headless: true, args })
      return { browser, args }
    } catch (err) {
      lastErr = err
    }
  }
  throw new Error(
    `no Chromium launch args produced a working browser: ${(lastErr as Error)?.message}`,
  )
}

function frameUrl(target: RenderTarget): string {
  const u = new URL(`${target.frameBaseUrl}/frame.html`)
  u.searchParams.set("hash", target.seed)
  u.searchParams.set("owner", target.owner)
  u.searchParams.set("context", "capture")
  return u.toString()
}

async function renderOnce(browser: Browser, target: RenderTarget): Promise<Buffer> {
  const page = await browser.newPage({
    viewport: { width: VIEWPORT, height: VIEWPORT },
    deviceScaleFactor: 1,
  })
  try {
    await page.goto(frameUrl(target), { waitUntil: "load" })
    await page.waitForSelector("#gl", { state: "attached" })
    await page.evaluate(
      () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())),
    )
    return await page.locator("#gl").screenshot({ type: "png" })
  } finally {
    await page.close()
  }
}

/**
 * Renders the token twice in separate pages and requires byte-identical
 * PNGs. A mismatch means the work isn't deterministic for this seed under
 * capture conditions, so the token is skipped rather than captured with
 * unverified output.
 */
export async function captureTokenDeterministic(
  browser: Browser,
  target: RenderTarget,
): Promise<{ png: Buffer; sha256: string }> {
  const a = await renderOnce(browser, target)
  const b = await renderOnce(browser, target)
  const shaA = sha256Hex(a)
  const shaB = sha256Hex(b)
  if (shaA !== shaB) {
    throw new Error(`non-deterministic render for seed ${target.seed}: ${shaA} vs ${shaB}`)
  }
  return { png: a, sha256: shaA }
}
