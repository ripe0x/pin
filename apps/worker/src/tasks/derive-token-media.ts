/**
 * Build bounded, disposable delivery derivatives for known artists' external
 * token media. Canonical art stays at its original URI. PND Surface contracts
 * are excluded because their permanent captures belong to RenderAssets and
 * the client-side #271/#272 pipeline.
 */
import { createHash } from "node:crypto"
import { lookup } from "node:dns/promises"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { isIP } from "node:net"
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
import { sql } from "../db.ts"
import {
  mediaObjectStorageFromEnv,
  objectKeyFor,
  putMediaObject,
  type MediaObjectStorage,
} from "../media/object-storage.ts"
import type { TaskResult } from "../scheduler.ts"

const TASK = "derive-token-media"
const INDEXER_SCHEMA = (process.env.INDEXER_SCHEMA ?? "indexer_live").replace(
  /[^a-zA-Z0-9_]/g,
  "",
)
const BATCH_SIZE = Math.min(Number(process.env.MEDIA_DERIVE_BATCH_SIZE ?? "12"), 50)
const MAX_ATTEMPTS = Math.min(Number(process.env.MEDIA_DERIVE_MAX_ATTEMPTS ?? "4"), 10)
const MAX_INPUT_BYTES = Math.min(
  Number(process.env.MEDIA_DERIVE_MAX_INPUT_BYTES ?? String(25 * 1024 * 1024)),
  50 * 1024 * 1024,
)
const MAX_PIXELS = Math.min(
  Number(process.env.MEDIA_DERIVE_MAX_PIXELS ?? String(60_000_000)),
  100_000_000,
)
const OUTPUT_WIDTH = Math.min(Number(process.env.MEDIA_DERIVE_WIDTH ?? "800"), 1600)
const FETCH_TIMEOUT_MS = 20_000
const DECODE_TIMEOUT_MS = 25_000

type Candidate = {
  contract: string
  tokenId: string
  sourceUrl: string
}

type LoadedSource = {
  bytes: Buffer
  mime: string
  resolvedUrl: string | null
  preferredGateway: string | null
}

type Derivative = {
  bytes: Buffer
  width: number
  height: number
  durationMs: number | null
  kind: "image" | "video"
  mime: "image/webp"
}

async function tableExists(schema: string, table: string): Promise<boolean> {
  const rows = (await sql`
    SELECT EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = ${schema} AND table_name = ${table}
    ) AS present
  `) as Array<{ present: boolean }>
  return rows[0]?.present === true
}

async function findCandidates(): Promise<Candidate[]> {
  const hasShared = await tableExists(INDEXER_SCHEMA, "fnd_artist_tokens")
  const hasSurface = await tableExists(INDEXER_SCHEMA, "collections")
  const shared = hasShared
    ? `
      UNION SELECT lower(t.contract), t.token_id::text
        FROM ${INDEXER_SCHEMA}.fnd_artist_tokens t
        JOIN known_artists k ON k.address = lower(t.creator)
      UNION SELECT lower(t.contract), t.token_id::text
        FROM ${INDEXER_SCHEMA}.srv2_artist_tokens t
        JOIN known_artists k ON k.address = lower(t.creator)`
    : ""
  const excludeSurface = hasSurface
    ? `AND NOT EXISTS (
         SELECT 1 FROM ${INDEXER_SCHEMA}.collections c
          WHERE lower(c.collection) = d.contract
       )`
    : ""
  return (await sql.unsafe(
    `WITH discovered(contract, token_id) AS (
       SELECT lower(t.contract), t.token_id
         FROM artist_tokens t
         JOIN known_artists k ON k.address = t.artist
       ${shared}
     ), candidates AS (
       SELECT DISTINCT d.contract, d.token_id,
              COALESCE(NULLIF(m.image_url, ''), NULLIF(m.animation_url, '')) AS source_url
         FROM discovered d
         JOIN token_metadata m
           ON m.contract = d.contract AND m.token_id = d.token_id
        WHERE NOT m.burned
          AND COALESCE(NULLIF(m.image_url, ''), NULLIF(m.animation_url, '')) IS NOT NULL
          ${excludeSurface}
     )
     SELECT c.contract, c.token_id AS "tokenId", c.source_url AS "sourceUrl"
       FROM candidates c
       LEFT JOIN token_media_delivery d
         ON d.contract = c.contract AND d.token_id = c.token_id
      WHERE d.contract IS NULL
         OR d.source_url <> c.source_url
         OR (d.status = 'pending' AND d.last_attempt_at < NOW() - INTERVAL '20 minutes')
         OR (d.status = 'failed' AND d.attempt_count < $1
             AND COALESCE(d.next_attempt_at, NOW()) <= NOW())
      ORDER BY COALESCE(d.last_attempt_at, '-infinity'::timestamptz)
      LIMIT $2`,
    [MAX_ATTEMPTS, BATCH_SIZE],
  )) as Candidate[]
}

function isPrivateIp(address: string): boolean {
  const normalized = address.toLowerCase()
  if (normalized === "::1" || normalized === "::" || normalized.startsWith("fe80:")) {
    return true
  }
  if (normalized.startsWith("fc") || normalized.startsWith("fd")) return true
  const mapped = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)?.[1]
  const v4 = mapped ?? (isIP(normalized) === 4 ? normalized : null)
  if (!v4) return false
  const [a, b] = v4.split(".").map(Number)
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    a >= 224
  )
}

async function assertPublicHttpUrl(value: string): Promise<URL> {
  const url = new URL(value)
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new UnsupportedMediaError(`unsupported source scheme ${url.protocol}`)
  }
  if (url.username || url.password) throw new Error("credentialed media URL rejected")
  const addresses = isIP(url.hostname)
    ? [{ address: url.hostname }]
    : await lookup(url.hostname, { all: true, verbatim: true })
  if (addresses.length === 0 || addresses.some((row) => isPrivateIp(row.address))) {
    throw new Error("non-public media host rejected")
  }
  return url
}

async function safeFetch(
  initialUrl: string,
  init: RequestInit,
  redirects = 3,
): Promise<{ response: Response; url: string }> {
  let current = initialUrl
  for (let i = 0; i <= redirects; i++) {
    await assertPublicHttpUrl(current)
    const response = await fetch(current, {
      ...init,
      redirect: "manual",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })
    if (response.status < 300 || response.status >= 400) {
      return { response, url: current }
    }
    const location = response.headers.get("location")
    await response.body?.cancel()
    if (!location || i === redirects) throw new Error("media redirect limit exceeded")
    current = new URL(location, current).toString()
  }
  throw new Error("media redirect limit exceeded")
}

async function readBounded(response: Response, limit: number): Promise<Buffer> {
  const length = Number(response.headers.get("content-length") ?? "0")
  if (length > limit) {
    await response.body?.cancel()
    throw new Error(`media exceeds ${limit} byte input ceiling`)
  }
  if (!response.body) return Buffer.alloc(0)
  const reader = response.body.getReader()
  const chunks: Buffer[] = []
  let total = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > limit) throw new Error(`media exceeds ${limit} byte input ceiling`)
      chunks.push(Buffer.from(value))
    }
  } finally {
    await reader.cancel().catch(() => undefined)
  }
  return Buffer.concat(chunks, total)
}

async function consumeProbePrefix(response: Response, limit: number): Promise<void> {
  if (!response.body) return
  const reader = response.body.getReader()
  let total = 0
  try {
    while (total < limit) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
    }
  } finally {
    await reader.cancel().catch(() => undefined)
  }
}

function decodeDataUri(uri: string): { bytes: Buffer; mime: string } {
  const comma = uri.indexOf(",")
  if (comma < 0) throw new UnsupportedMediaError("malformed data URI")
  const meta = uri.slice(5, comma)
  const mime = meta.split(";")[0].toLowerCase() || "application/octet-stream"
  const body = uri.slice(comma + 1)
  const bytes = /;base64(?:;|$)/i.test(meta)
    ? Buffer.from(body, "base64")
    : Buffer.from(decodeURIComponent(body))
  if (bytes.length > MAX_INPUT_BYTES) throw new Error("inline media exceeds input ceiling")
  return { bytes, mime }
}

function sourceCandidates(sourceUrl: string): string[] {
  const cidPath = extractCid(sourceUrl)
  if (cidPath) return ipfsCidToFallbackUrls(cidPath)
  const arweavePath = extractArweavePath(sourceUrl)
  if (arweavePath) return arweavePathToFallbackUrls(arweavePath)
  return [ipfsToHttp(sourceUrl)]
}

function exactSourcePath(sourceUrl: string): string | null {
  const contentPath = extractCid(sourceUrl) ?? extractArweavePath(sourceUrl)
  if (contentPath) return contentPath
  try {
    const url = new URL(sourceUrl)
    return `${url.pathname}${url.search}${url.hash}`
  } catch {
    return null
  }
}

async function probeAndLoad(sourceUrl: string): Promise<LoadedSource> {
  if (sourceUrl.startsWith("data:")) {
    const decoded = decodeDataUri(sourceUrl)
    return {
      ...decoded,
      resolvedUrl: null,
      preferredGateway: null,
    }
  }

  const errors: string[] = []
  for (const candidate of sourceCandidates(sourceUrl)) {
    try {
      let mime = ""
      const head = await safeFetch(candidate, { method: "HEAD" }).catch(() => null)
      if (head?.response.ok) {
        mime = head.response.headers.get("content-type")?.split(";")[0].toLowerCase() ?? ""
        const length = Number(head.response.headers.get("content-length") ?? "0")
        if (length > MAX_INPUT_BYTES) throw new Error("media exceeds input ceiling")
      } else {
        const ranged = await safeFetch(candidate, {
          headers: { Range: "bytes=0-65535", Accept: "image/*,video/*;q=0.9,*/*;q=0.1" },
        })
        if (!ranged.response.ok) throw new Error(`probe returned ${ranged.response.status}`)
        mime = ranged.response.headers.get("content-type")?.split(";")[0].toLowerCase() ?? ""
        const contentRange = ranged.response.headers.get("content-range")
        const total = Number(contentRange?.match(/\/(\d+)$/)?.[1] ?? "0")
        if (total > MAX_INPUT_BYTES) throw new Error("media exceeds input ceiling")
        await consumeProbePrefix(ranged.response, 65_536)
      }
      const loaded = await safeFetch(candidate, {
        headers: { Accept: "image/*,video/*;q=0.9,*/*;q=0.1" },
      })
      if (!loaded.response.ok) throw new Error(`download returned ${loaded.response.status}`)
      const responseMime =
        loaded.response.headers.get("content-type")?.split(";")[0].toLowerCase() ?? ""
      const bytes = await readBounded(loaded.response, MAX_INPUT_BYTES)
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

function classify(
  mime: string,
  sourceUrl: string,
  bytes: Buffer,
): "image" | "video" {
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

async function imageDerivative(source: Buffer): Promise<Derivative> {
  const pipeline = sharp(source, { limitInputPixels: MAX_PIXELS, animated: false })
    .rotate()
    .resize({ width: OUTPUT_WIDTH, height: OUTPUT_WIDTH, fit: "inside", withoutEnlargement: true })
    .webp({ quality: 80, effort: 4 })
    .timeout({ seconds: Math.ceil(DECODE_TIMEOUT_MS / 1_000) })
  const result = await pipeline.toBuffer({ resolveWithObject: true })
  return {
    bytes: result.data,
    width: result.info.width,
    height: result.info.height,
    durationMs: null,
    kind: "image",
    mime: "image/webp",
  }
}

async function runProcess(
  command: string,
  args: string[],
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
    const timer = setTimeout(() => child.kill("SIGKILL"), DECODE_TIMEOUT_MS)
    child.once("error", reject)
    child.once("exit", (code, signal) => {
      clearTimeout(timer)
      if (code === 0) resolve({ stdout, stderr })
      else reject(new Error(`${command} failed (${signal ?? code}): ${stderr}`))
    })
  })
}

async function videoDerivative(source: Buffer): Promise<Derivative> {
  const dir = await mkdtemp(join(tmpdir(), "pnd-media-"))
  const input = join(dir, "source")
  const output = join(dir, "poster.webp")
  try {
    await writeFile(input, source)
    const probe = await runProcess("ffprobe", [
      "-v", "error", "-select_streams", "v:0",
      "-show_entries", "format=duration:stream=width,height",
      "-of", "json", input,
    ])
    const probeJson = JSON.parse(probe.stdout) as {
      streams?: Array<{ width?: number; height?: number }>
      format?: { duration?: string }
    }
    await runProcess("ffmpeg", [
      "-v", "error", "-ss", "0", "-i", input, "-frames:v", "1",
      "-vf", `scale=${OUTPUT_WIDTH}:${OUTPUT_WIDTH}:force_original_aspect_ratio=decrease`,
      "-c:v", "libwebp", "-quality", "80", "-y", output,
    ])
    const bytes = await readFile(output)
    const info = await sharp(bytes).metadata()
    if (!info.width || !info.height) throw new Error("poster dimensions unavailable")
    const seconds = Number(probeJson.format?.duration ?? "")
    return {
      bytes,
      width: info.width,
      height: info.height,
      durationMs: Number.isFinite(seconds) && seconds >= 0 ? Math.round(seconds * 1000) : null,
      kind: "video",
      mime: "image/webp",
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

class UnsupportedMediaError extends Error {}

function hash(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex")
}

async function markAttempt(candidate: Candidate): Promise<number> {
  const rows = (await sql`
    INSERT INTO token_media_delivery
      (contract, token_id, source_url, source_path, status, attempt_count,
       last_attempt_at, next_attempt_at, last_error, updated_at)
    VALUES
       (${candidate.contract}, ${candidate.tokenId}, ${candidate.sourceUrl},
       ${exactSourcePath(candidate.sourceUrl)}, 'pending', 1, NOW(), NULL, NULL, NOW())
    ON CONFLICT (contract, token_id) DO UPDATE SET
      source_url = EXCLUDED.source_url,
      source_path = EXCLUDED.source_path,
      status = 'pending',
      attempt_count = CASE
        WHEN token_media_delivery.source_url <> EXCLUDED.source_url THEN 1
        ELSE token_media_delivery.attempt_count + 1
      END,
      last_attempt_at = NOW(), next_attempt_at = NULL, last_error = NULL,
      updated_at = NOW()
    RETURNING attempt_count
  `) as Array<{ attempt_count: number }>
  return rows[0]?.attempt_count ?? 1
}

async function reuseExactSource(candidate: Candidate): Promise<boolean> {
  const rows = (await sql`
    SELECT media_kind, resolved_url, source_path, thumbnail_url, poster_url,
           width, height, duration_ms, mime_type, source_bytes,
           derivative_bytes, source_sha256, derivative_sha256, preferred_gateway
      FROM token_media_delivery
     WHERE source_url = ${candidate.sourceUrl} AND status = 'ready'
       AND (thumbnail_url IS NOT NULL OR poster_url IS NOT NULL)
     LIMIT 1
  `) as Array<Record<string, unknown>>
  const source = rows[0]
  if (!source) return false
  await sql`
    UPDATE token_media_delivery SET
      status = 'ready', media_kind = ${source.media_kind as string},
      resolved_url = ${source.resolved_url as string | null},
      source_path = ${source.source_path as string | null},
      thumbnail_url = ${source.thumbnail_url as string | null},
      poster_url = ${source.poster_url as string | null},
      width = ${source.width as number | null}, height = ${source.height as number | null},
      duration_ms = ${source.duration_ms as number | null}, mime_type = ${source.mime_type as string | null},
      source_bytes = ${source.source_bytes as number | null},
      derivative_bytes = ${source.derivative_bytes as number | null},
      source_sha256 = ${source.source_sha256 as string | null},
      derivative_sha256 = ${source.derivative_sha256 as string | null},
      preferred_gateway = ${source.preferred_gateway as string | null},
      last_success_at = NOW(), next_attempt_at = NULL, last_error = NULL, updated_at = NOW()
    WHERE contract = ${candidate.contract} AND token_id = ${candidate.tokenId}
  `
  return true
}

async function processCandidate(
  candidate: Candidate,
  storage: MediaObjectStorage,
): Promise<void> {
  const attempt = await markAttempt(candidate)
  if (await reuseExactSource(candidate)) return
  try {
    const source = await probeAndLoad(candidate.sourceUrl)
    const kind = classify(source.mime, candidate.sourceUrl, source.bytes)
    const derivative =
      kind === "image"
        ? await imageDerivative(source.bytes)
        : await videoDerivative(source.bytes)
    const sourceHash = hash(source.bytes)
    const derivativeHash = hash(derivative.bytes)
    const key = objectKeyFor(storage, derivativeHash, "webp")
    const url = await putMediaObject(storage, key, derivative.bytes, derivative.mime)
    await sql`
      UPDATE token_media_delivery SET
        status = 'ready', media_kind = ${derivative.kind},
        resolved_url = ${source.resolvedUrl}, preferred_gateway = ${source.preferredGateway},
        thumbnail_url = ${derivative.kind === "image" ? url : null},
        poster_url = ${derivative.kind === "video" ? url : null},
        width = ${derivative.width}, height = ${derivative.height},
        duration_ms = ${derivative.durationMs}, mime_type = ${source.mime},
        source_bytes = ${source.bytes.length}, derivative_bytes = ${derivative.bytes.length},
        source_sha256 = ${sourceHash}, derivative_sha256 = ${derivativeHash},
        last_success_at = NOW(), next_attempt_at = NULL, last_error = NULL,
        updated_at = NOW()
      WHERE contract = ${candidate.contract} AND token_id = ${candidate.tokenId}
    `
  } catch (error) {
    const unsupported = error instanceof UnsupportedMediaError
    const delayHours = Math.min(2 ** Math.max(attempt - 1, 0), 24)
    const message = (error as Error).message.slice(0, 1_000)
    await sql`
      UPDATE token_media_delivery SET
        status = ${unsupported ? "unsupported" : "failed"},
        media_kind = ${unsupported ? "animation" : "unknown"},
        last_error = ${message},
        next_attempt_at = ${unsupported || attempt >= MAX_ATTEMPTS ? null : new Date(Date.now() + delayHours * 3_600_000)},
        updated_at = NOW()
      WHERE contract = ${candidate.contract} AND token_id = ${candidate.tokenId}
    `
    if (!unsupported) console.error(`[${TASK}] ${candidate.contract}/${candidate.tokenId}: ${message}`)
  }
}

export async function deriveTokenMedia(): Promise<TaskResult> {
  const storage = mediaObjectStorageFromEnv()
  if (!storage) return { scopeCount: 0, rpcCalls: 0, rowsWritten: 0 }
  const candidates = await findCandidates()
  for (const candidate of candidates) {
    await processCandidate(candidate, storage)
  }
  return { scopeCount: candidates.length, rpcCalls: 0, rowsWritten: candidates.length }
}
