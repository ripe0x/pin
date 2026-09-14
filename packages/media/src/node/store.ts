import { createHash, createHmac } from "node:crypto"
import { mkdir, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"

/** Where a derived thumbnail or poster is written and served from. */
export type MediaStore = {
  put(key: string, bytes: Uint8Array, contentType: string): Promise<{ url: string }>
}

export type S3StoreConfig = {
  endpoint: URL
  bucket: string
  publicBaseUrl: string
  accessKeyId: string
  secretAccessKey: string
  region: string
  prefix: string
}

function cleanSegment(value: string): string {
  return value.replace(/^\/+|\/+$/g, "")
}

/** Reads an S3-compatible store config from `MEDIA_OBJECT_*` env vars. Throws if only some are set. */
export function s3ConfigFromEnv(env: NodeJS.ProcessEnv = process.env): S3StoreConfig | null {
  const endpoint = env.MEDIA_OBJECT_ENDPOINT
  const bucket = env.MEDIA_OBJECT_BUCKET
  const publicBaseUrl = env.MEDIA_OBJECT_PUBLIC_BASE_URL
  const accessKeyId = env.MEDIA_OBJECT_ACCESS_KEY_ID
  const secretAccessKey = env.MEDIA_OBJECT_SECRET_ACCESS_KEY
  const values = [endpoint, bucket, publicBaseUrl, accessKeyId, secretAccessKey]
  if (values.every((value) => !value)) return null
  if (values.some((value) => !value)) {
    throw new Error(
      "MEDIA_OBJECT_ENDPOINT, MEDIA_OBJECT_BUCKET, MEDIA_OBJECT_PUBLIC_BASE_URL, " +
        "MEDIA_OBJECT_ACCESS_KEY_ID, and MEDIA_OBJECT_SECRET_ACCESS_KEY must be set together",
    )
  }
  const parsed = new URL(endpoint!)
  if (parsed.protocol !== "https:") throw new Error("MEDIA_OBJECT_ENDPOINT must use https")
  const publicUrl = new URL(publicBaseUrl!)
  if (publicUrl.protocol !== "https:") {
    throw new Error("MEDIA_OBJECT_PUBLIC_BASE_URL must use https")
  }
  if (!cleanSegment(bucket!)) throw new Error("MEDIA_OBJECT_BUCKET cannot be empty")
  return {
    endpoint: parsed,
    bucket: cleanSegment(bucket!),
    publicBaseUrl: publicUrl.toString().replace(/\/+$/, ""),
    accessKeyId: accessKeyId!,
    secretAccessKey: secretAccessKey!,
    region: env.MEDIA_OBJECT_REGION || "auto",
    prefix: cleanSegment(env.MEDIA_OBJECT_PREFIX || "media-cache/v1"),
  }
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex")
}

function hmac(key: string | Buffer, value: string): Buffer {
  return createHmac("sha256", key).update(value).digest()
}

function encodePath(path: string): string {
  return path
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/")
}

/** Builds a SigV4-signed S3 PUT request. No AWS SDK dependency. */
export function buildSignedPutRequest(
  config: S3StoreConfig,
  key: string,
  bytes: Uint8Array,
  contentType: string,
  now = new Date(),
): { url: string; headers: Record<string, string> } {
  const date = now.toISOString().replace(/[:-]|\.\d{3}/g, "")
  const day = date.slice(0, 8)
  const payloadHash = sha256(bytes)
  const basePath = config.endpoint.pathname.replace(/\/$/, "")
  const canonicalUri = `${basePath}/${encodePath(config.bucket)}/${encodePath(key)}`
  const host = config.endpoint.host
  const canonicalHeaders =
    "cache-control:public, max-age=31536000, immutable\n" +
    `content-type:${contentType}\n` +
    `host:${host}\n` +
    `x-amz-content-sha256:${payloadHash}\n` +
    `x-amz-date:${date}\n`
  const signedHeaders = "cache-control;content-type;host;x-amz-content-sha256;x-amz-date"
  const canonicalRequest = ["PUT", canonicalUri, "", canonicalHeaders, signedHeaders, payloadHash].join(
    "\n",
  )
  const scope = `${day}/${config.region}/s3/aws4_request`
  const stringToSign = ["AWS4-HMAC-SHA256", date, scope, sha256(canonicalRequest)].join("\n")
  const dateKey = hmac(`AWS4${config.secretAccessKey}`, day)
  const regionKey = hmac(dateKey, config.region)
  const serviceKey = hmac(regionKey, "s3")
  const signingKey = hmac(serviceKey, "aws4_request")
  const signature = createHmac("sha256", signingKey).update(stringToSign).digest("hex")
  const authorization =
    `AWS4-HMAC-SHA256 Credential=${config.accessKeyId}/${scope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`

  return {
    url: new URL(canonicalUri, config.endpoint.origin).toString(),
    headers: {
      authorization,
      "cache-control": "public, max-age=31536000, immutable",
      "content-type": contentType,
      "x-amz-content-sha256": payloadHash,
      "x-amz-date": date,
    },
  }
}

/** S3-compatible object storage, reached with a hand-rolled SigV4 PUT. */
export function s3Store(config: S3StoreConfig): MediaStore {
  return {
    async put(key, bytes, contentType) {
      const request = buildSignedPutRequest(config, key, bytes, contentType)
      // Copy onto a plain ArrayBuffer. Node accepts a Uint8Array directly, but
      // the DOM BodyInit type rejects one backed by SharedArrayBuffer.
      const body = Uint8Array.from(bytes).buffer
      const response = await fetch(request.url, {
        method: "PUT",
        headers: request.headers,
        body,
        signal: AbortSignal.timeout(30_000),
      })
      if (!response.ok) {
        const text = (await response.text().catch(() => "")).slice(0, 300)
        throw new Error(`object PUT failed (${response.status}): ${text || response.statusText}`)
      }
      return { url: `${config.publicBaseUrl}/${encodePath(key)}` }
    },
  }
}

/** `s3Store` configured from `MEDIA_OBJECT_*` env vars, or null if unset. */
export function mediaStoreFromEnv(env: NodeJS.ProcessEnv = process.env): MediaStore | null {
  const config = s3ConfigFromEnv(env)
  return config ? s3Store(config) : null
}

/**
 * Local filesystem store: writes `<dir>/<key>` and returns `<publicBase>/<key>`.
 * What an artist site build uses, writing under `public/media` and serving
 * the same path the built site is deployed from.
 */
export function fileStore(config: { dir: string; publicBase: string }): MediaStore {
  return {
    async put(key, bytes) {
      const filePath = join(config.dir, key)
      await mkdir(dirname(filePath), { recursive: true })
      await writeFile(filePath, bytes)
      const base = config.publicBase.replace(/\/+$/, "")
      return { url: `${base}/${encodePath(key)}` }
    },
  }
}
