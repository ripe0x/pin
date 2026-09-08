import { recordKey, type MediaRecord } from "./record.ts"

/**
 * Portable carrier for media records: what a static artist site ships
 * alongside its build instead of querying a database. `records` is keyed
 * by `recordKey(contract, tokenId)`.
 */
export type MediaManifest = {
  version: 1
  generatedAt: string
  records: Record<string, MediaRecord>
}

const KIND_VALUES = new Set(["image", "video", "animation", "unknown"])
const STATUS_VALUES = new Set(["pending", "ready", "unsupported", "failed"])

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string"
}

function isNullableNumber(value: unknown): value is number | null {
  return value === null || typeof value === "number"
}

function fail(message: string): never {
  throw new Error(`invalid media manifest: ${message}`)
}

function parseRecord(key: string, value: unknown): MediaRecord {
  if (typeof value !== "object" || value === null) fail(`record ${key} is not an object`)
  const r = value as Record<string, unknown>
  if (typeof r.contract !== "string") fail(`record ${key} has no contract`)
  if (typeof r.tokenId !== "string") fail(`record ${key} has no tokenId`)
  if (typeof r.sourceUrl !== "string") fail(`record ${key} has no sourceUrl`)
  if (typeof r.kind !== "string" || !KIND_VALUES.has(r.kind)) {
    fail(`record ${key} has an invalid kind`)
  }
  if (typeof r.status !== "string" || !STATUS_VALUES.has(r.status)) {
    fail(`record ${key} has an invalid status`)
  }
  const stringFields = [
    "resolvedUrl",
    "thumbnailUrl",
    "posterUrl",
    "mimeType",
    "sourceSha256",
    "derivativeSha256",
    "preferredGateway",
    "lastError",
    "lastAttemptAt",
    "lastSuccessAt",
    "nextAttemptAt",
  ] as const
  for (const field of stringFields) {
    if (!isNullableString(r[field])) fail(`record ${key} field ${field} must be a string or null`)
  }
  const numberFields = [
    "width",
    "height",
    "durationMs",
    "sourceBytes",
    "derivativeBytes",
  ] as const
  for (const field of numberFields) {
    if (!isNullableNumber(r[field])) fail(`record ${key} field ${field} must be a number or null`)
  }
  if (typeof r.attemptCount !== "number") fail(`record ${key} has no attemptCount`)
  if (recordKey(r.contract, r.tokenId) !== key) {
    fail(`record ${key} is keyed under a different contract/tokenId`)
  }
  return r as unknown as MediaRecord
}

/** Parse and validate a manifest read from disk. Throws with a field-level message. */
export function parseManifest(json: unknown): MediaManifest {
  if (typeof json !== "object" || json === null) fail("root is not an object")
  const m = json as Record<string, unknown>
  if (m.version !== 1) fail("version must be 1")
  if (typeof m.generatedAt !== "string") fail("generatedAt must be a string")
  if (typeof m.records !== "object" || m.records === null) fail("records must be an object")
  const records: Record<string, MediaRecord> = {}
  for (const [key, value] of Object.entries(m.records as Record<string, unknown>)) {
    records[key] = parseRecord(key, value)
  }
  return { version: 1, generatedAt: m.generatedAt, records }
}

/** Build a `(ref) => MediaRecord | null` lookup over a manifest's records. */
export function manifestLookup(
  manifest: MediaManifest,
): (ref: { contract: string; tokenId: string }) => MediaRecord | null {
  return (ref) => manifest.records[recordKey(ref.contract, ref.tokenId)] ?? null
}
