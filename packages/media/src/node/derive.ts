import { createHash } from "node:crypto"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { spawn } from "node:child_process"
import sharp from "sharp"
import {
  arweavePathToFallbackUrls,
  extractArweavePath,
  extractCid,
  ipfsCidToFallbackUrls,
  ipfsToHttp,
} from "@pin/shared"
import {
  UnsupportedMediaError,
  consumeProbePrefix,
  decodeDataUri,
  readBounded,
  safeFetch,
} from "./fetch.ts"

export type DeriveOptions = {
  /** Ceiling on the fetched source, in bytes. Default 25MB, hard cap 50MB. */
  maxInputBytes?: number
  /** Ceiling on decoded image pixel count. Default 60M, hard cap 100M. */
  maxPixels?: number
  /** Output thumbnail/poster width in px. Default 800, hard cap 1600. */
  outputWidth?: number
  /** Per-request fetch timeout, in ms. Default 20s. */
  fetchTimeoutMs?: number
  /** ffmpeg/sharp decode timeout, in ms. Default 25s. */
  decodeTimeoutMs?: number
}

type ResolvedDeriveOptions = Required<DeriveOptions>

const DEFAULTS: ResolvedDeriveOptions = {
  maxInputBytes: 25 * 1024 * 1024,
  maxPixels: 60_000_000,
  outputWidth: 800,
  fetchTimeoutMs: 20_000,
  decodeTimeoutMs: 25_000,
}

const HARD_CEILINGS: ResolvedDeriveOptions = {
  maxInputBytes: 50 * 1024 * 1024,
  maxPixels: 100_000_000,
  outputWidth: 1600,
  fetchTimeoutMs: 20_000,
  decodeTimeoutMs: 25_000,
}

function resolveOptions(opts: DeriveOptions = {}): ResolvedDeriveOptions {
  return {
    maxInputBytes: Math.min(opts.maxInputBytes ?? DEFAULTS.maxInputBytes, HARD_CEILINGS.maxInputBytes),
    maxPixels: Math.min(opts.maxPixels ?? DEFAULTS.maxPixels, HARD_CEILINGS.maxPixels),
    outputWidth: Math.min(opts.outputWidth ?? DEFAULTS.outputWidth, HARD_CEILINGS.outputWidth),
    fetchTimeoutMs: opts.fetchTimeoutMs ?? DEFAULTS.fetchTimeoutMs,
    decodeTimeoutMs: opts.decodeTimeoutMs ?? DEFAULTS.decodeTimeoutMs,
  }
}

export type LoadedSource = {
  bytes: Buffer
  mime: string
  resolvedUrl: string | null
  preferredGateway: string | null
}

export type DerivedMedia = {
  bytes: Buffer
  width: number
  height: number
  durationMs: number | null
  kind: "image" | "video"
  mime: "image/webp"
  sha256: string
  sourceBytes: number
  sourceMime: string
  sourceSha256: string
  resolvedUrl: string | null
  preferredGateway: string | null
}

function sourceCandidates(sourceUrl: string): string[] {
  const cidPath = extractCid(sourceUrl)
  if (cidPath) return ipfsCidToFallbackUrls(cidPath)
  const arweavePath = extractArweavePath(sourceUrl)
  if (arweavePath) return arweavePathToFallbackUrls(arweavePath)
  return [ipfsToHttp(sourceUrl)]
}

/**
 * Loads a token's source media. A `data:` URI decodes inline; anything else
 * expands to its gateway candidates and is probed (HEAD, else a ranged GET)
 * before the full body downloads, so an oversized file is rejected without
 * pulling the whole thing.
 */
export async function loadMediaSource(
  sourceUrl: string,
  opts: DeriveOptions = {},
): Promise<LoadedSource> {
  const resolved = resolveOptions(opts)
  if (sourceUrl.startsWith("data:")) {
    const decoded = decodeDataUri(sourceUrl, resolved.maxInputBytes)
    return { ...decoded, resolvedUrl: null, preferredGateway: null }
  }

  const errors: string[] = []
  for (const candidate of sourceCandidates(sourceUrl)) {
    try {
      let mime = ""
      const head = await safeFetch(
        candidate,
        { method: "HEAD" },
        { timeoutMs: resolved.fetchTimeoutMs },
      ).catch(() => null)
      if (head?.response.ok) {
        mime = head.response.headers.get("content-type")?.split(";")[0].toLowerCase() ?? ""
        const length = Number(head.response.headers.get("content-length") ?? "0")
        if (length > resolved.maxInputBytes) throw new Error("media exceeds input ceiling")
      } else {
        const ranged = await safeFetch(
          candidate,
          { headers: { Range: "bytes=0-65535", Accept: "image/*,video/*;q=0.9,*/*;q=0.1" } },
          { timeoutMs: resolved.fetchTimeoutMs },
        )
        if (!ranged.response.ok) throw new Error(`probe returned ${ranged.response.status}`)
        mime = ranged.response.headers.get("content-type")?.split(";")[0].toLowerCase() ?? ""
        const contentRange = ranged.response.headers.get("content-range")
        const total = Number(contentRange?.match(/\/(\d+)$/)?.[1] ?? "0")
        if (total > resolved.maxInputBytes) throw new Error("media exceeds input ceiling")
        await consumeProbePrefix(ranged.response, 65_536)
      }
      const loaded = await safeFetch(
        candidate,
        { headers: { Accept: "image/*,video/*;q=0.9,*/*;q=0.1" } },
        { timeoutMs: resolved.fetchTimeoutMs },
      )
      if (!loaded.response.ok) throw new Error(`download returned ${loaded.response.status}`)
      const responseMime =
        loaded.response.headers.get("content-type")?.split(";")[0].toLowerCase() ?? ""
      const bytes = await readBounded(loaded.response, resolved.maxInputBytes)
      return {
        bytes,
        mime: responseMime || mime || "application/octet-stream",
        resolvedUrl: loaded.url,
        preferredGateway: new URL(loaded.url).origin,
      }
    } catch (error) {
      if (error instanceof UnsupportedMediaError) throw error
      errors.push(`${candidate}: ${(error as Error).message}`)
    }
  }
  throw new Error(errors.join("; ").slice(0, 600) || "media unavailable")
}

/**
 * Classifies loaded bytes as image or video by MIME type, then magic bytes,
 * then file extension. Anything that resolves to HTML or audio is rejected
 * as unsupported rather than misclassified.
 */
export function classifyMedia(mime: string, sourceUrl: string, bytes: Buffer): "image" | "video" {
  if (mime.startsWith("image/")) return "image"
  if (mime.startsWith("video/")) return "video"
  const prefix = bytes.subarray(0, 256)
  const ascii = prefix.toString("utf8").trimStart().toLowerCase()
  if (
    prefix.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) ||
    prefix.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff])) ||
    prefix.subarray(0, 6).toString("ascii").startsWith("GIF8") ||
    (prefix.subarray(0, 4).toString("ascii") === "RIFF" &&
      prefix.subarray(8, 12).toString("ascii") === "WEBP") ||
    (prefix.subarray(4, 8).toString("ascii") === "ftyp" &&
      /^(avif|avis|heic|heix|mif1)$/.test(prefix.subarray(8, 12).toString("ascii"))) ||
    ascii.startsWith("<svg") ||
    ascii.startsWith("<?xml")
  ) {
    return "image"
  }
  if (
    prefix.subarray(4, 8).toString("ascii") === "ftyp" ||
    prefix.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))
  ) {
    return "video"
  }
  const pathname = sourceUrl.split(/[?#]/)[0].toLowerCase()
  if (/\.(png|jpe?g|gif|webp|avif|svg)$/.test(pathname)) return "image"
  if (/\.(mp4|mov|webm|ogv)$/.test(pathname)) return "video"
  if (mime.includes("html") || mime.startsWith("audio/")) {
    throw new UnsupportedMediaError(`unsupported media type ${mime}`)
  }
  throw new UnsupportedMediaError(`unrecognized media type ${mime}`)
}

export async function deriveImageThumbnail(
  source: Buffer,
  opts: DeriveOptions = {},
): Promise<{ bytes: Buffer; width: number; height: number }> {
  const resolved = resolveOptions(opts)
  const pipeline = sharp(source, { limitInputPixels: resolved.maxPixels, animated: false })
    .rotate()
    .resize({
      width: resolved.outputWidth,
      height: resolved.outputWidth,
      fit: "inside",
      withoutEnlargement: true,
    })
    .webp({ quality: 80, effort: 4 })
    .timeout({ seconds: Math.ceil(resolved.decodeTimeoutMs / 1_000) })
  const result = await pipeline.toBuffer({ resolveWithObject: true })
  return { bytes: result.data, width: result.info.width, height: result.info.height }
}

async function runProcess(
  command: string,
  args: string[],
  timeoutMs: number,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] })
    let stdout = ""
    let stderr = ""
    child.stdout.on("data", (chunk) => {
      stdout = (stdout + chunk.toString()).slice(-20_000)
    })
    child.stderr.on("data", (chunk) => {
      stderr = (stderr + chunk.toString()).slice(-2_000)
    })
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs)
    child.once("error", reject)
    child.once("exit", (code, signal) => {
      clearTimeout(timer)
      if (code === 0) resolve({ stdout, stderr })
      else reject(new Error(`${command} failed (${signal ?? code}): ${stderr}`))
    })
  })
}

export async function deriveVideoPoster(
  source: Buffer,
  opts: DeriveOptions = {},
): Promise<{ bytes: Buffer; width: number; height: number; durationMs: number | null }> {
  const resolved = resolveOptions(opts)
  const dir = await mkdtemp(join(tmpdir(), "pnd-media-"))
  const input = join(dir, "source")
  const output = join(dir, "poster.webp")
  try {
    await writeFile(input, source)
    const probe = await runProcess(
      "ffprobe",
      [
        "-v", "error", "-select_streams", "v:0",
        "-show_entries", "format=duration:stream=width,height",
        "-of", "json", input,
      ],
      resolved.decodeTimeoutMs,
    )
    const probeJson = JSON.parse(probe.stdout) as {
      streams?: Array<{ width?: number; height?: number }>
      format?: { duration?: string }
    }
    await runProcess(
      "ffmpeg",
      [
        "-v", "error", "-ss", "0", "-i", input, "-frames:v", "1",
        "-vf", `scale=${resolved.outputWidth}:${resolved.outputWidth}:force_original_aspect_ratio=decrease`,
        "-c:v", "libwebp", "-quality", "80", "-y", output,
      ],
      resolved.decodeTimeoutMs,
    )
    const bytes = await readFile(output)
    const info = await sharp(bytes).metadata()
    if (!info.width || !info.height) throw new Error("poster dimensions unavailable")
    const seconds = Number(probeJson.format?.duration ?? "")
    return {
      bytes,
      width: info.width,
      height: info.height,
      durationMs: Number.isFinite(seconds) && seconds >= 0 ? Math.round(seconds * 1000) : null,
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

function hash(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex")
}

/**
 * Loads a token's source media, classifies it, and derives the delivery
 * derivative: an 800px WebP thumbnail for an image, a WebP poster frame
 * (via ffmpeg/ffprobe) for a video. Canonical source bytes are never kept
 * past this call; only the derivative and both hashes are returned.
 */
export async function deriveMedia(
  sourceUrl: string,
  opts: DeriveOptions = {},
): Promise<DerivedMedia> {
  const source = await loadMediaSource(sourceUrl, opts)
  const kind = classifyMedia(source.mime, sourceUrl, source.bytes)
  const derivative =
    kind === "image"
      ? { ...(await deriveImageThumbnail(source.bytes, opts)), durationMs: null }
      : await deriveVideoPoster(source.bytes, opts)
  return {
    bytes: derivative.bytes,
    width: derivative.width,
    height: derivative.height,
    durationMs: derivative.durationMs,
    kind,
    mime: "image/webp",
    sha256: hash(derivative.bytes),
    sourceBytes: source.bytes.length,
    sourceMime: source.mime,
    sourceSha256: hash(source.bytes),
    resolvedUrl: source.resolvedUrl,
    preferredGateway: source.preferredGateway,
  }
}
