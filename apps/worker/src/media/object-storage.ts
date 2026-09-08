import { createHash, createHmac } from "node:crypto"

export type MediaObjectStorage = {
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

export function mediaObjectStorageFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): MediaObjectStorage | null {
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
  if (parsed.protocol !== "https:") {
    throw new Error("MEDIA_OBJECT_ENDPOINT must use https")
  }
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

export function objectKeyFor(
  storage: MediaObjectStorage,
  derivativeHash: string,
  extension: string,
): string {
  const ext = extension.replace(/[^a-z0-9]/gi, "").toLowerCase()
  if (!/^[0-9a-f]{64}$/.test(derivativeHash) || !ext) {
    throw new Error("Invalid derivative object identity")
  }
  return `${storage.prefix}/${derivativeHash.slice(0, 2)}/${derivativeHash}.${ext}`
}

export function buildSignedPutRequest(
  storage: MediaObjectStorage,
  key: string,
  bytes: Uint8Array,
  contentType: string,
  now = new Date(),
): { url: string; headers: Record<string, string> } {
  const date = now.toISOString().replace(/[:-]|\.\d{3}/g, "")
  const day = date.slice(0, 8)
  const payloadHash = sha256(bytes)
  const basePath = storage.endpoint.pathname.replace(/\/$/, "")
  const canonicalUri = `${basePath}/${encodePath(storage.bucket)}/${encodePath(key)}`
  const host = storage.endpoint.host
  const canonicalHeaders =
    "cache-control:public, max-age=31536000, immutable\n" +
    `content-type:${contentType}\n` +
    `host:${host}\n` +
    `x-amz-content-sha256:${payloadHash}\n` +
    `x-amz-date:${date}\n`
  const signedHeaders =
    "cache-control;content-type;host;x-amz-content-sha256;x-amz-date"
  const canonicalRequest = [
    "PUT",
    canonicalUri,
    "",
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n")
  const scope = `${day}/${storage.region}/s3/aws4_request`
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    date,
    scope,
    sha256(canonicalRequest),
  ].join("\n")
  const dateKey = hmac(`AWS4${storage.secretAccessKey}`, day)
  const regionKey = hmac(dateKey, storage.region)
  const serviceKey = hmac(regionKey, "s3")
  const signingKey = hmac(serviceKey, "aws4_request")
  const signature = createHmac("sha256", signingKey).update(stringToSign).digest("hex")
  const authorization =
    `AWS4-HMAC-SHA256 Credential=${storage.accessKeyId}/${scope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`

  return {
    url: new URL(canonicalUri, storage.endpoint.origin).toString(),
    headers: {
      authorization,
      "cache-control": "public, max-age=31536000, immutable",
      "content-type": contentType,
      "x-amz-content-sha256": payloadHash,
      "x-amz-date": date,
    },
  }
}

export async function putMediaObject(
  storage: MediaObjectStorage,
  key: string,
  bytes: Uint8Array,
  contentType: string,
): Promise<string> {
  const request = buildSignedPutRequest(storage, key, bytes, contentType)
  // Copy onto a plain ArrayBuffer. Node accepts Uint8Array directly, but the
  // DOM BodyInit type rejects a Uint8Array backed by SharedArrayBuffer.
  const body = Uint8Array.from(bytes).buffer
  const response = await fetch(request.url, {
    method: "PUT",
    headers: request.headers,
    body,
    signal: AbortSignal.timeout(30_000),
  })
  if (!response.ok) {
    const body = (await response.text().catch(() => "")).slice(0, 300)
    throw new Error(`object PUT failed (${response.status}): ${body || response.statusText}`)
  }
  return `${storage.publicBaseUrl}/${encodePath(key)}`
}
