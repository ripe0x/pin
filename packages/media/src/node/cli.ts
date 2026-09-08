import { parseArgs } from "node:util"
import { readFile, writeFile } from "node:fs/promises"
import { recordKey, type MediaRecord } from "../record.ts"
import { parseManifest, type MediaManifest } from "../manifest.ts"
import { derivativeKey } from "../derivative.ts"
import { deriveMedia } from "./derive.ts"
import { fileStore, type MediaStore } from "./store.ts"

type InputItem = { contract: string; tokenId: string; sourceUrl: string }

const DERIVATIVE_PREFIX = "media"
const CONCURRENCY = 2
const USAGE =
  "usage: pnd-media derive --input <json> --out <dir> --public-base <url-or-path> --manifest <path>"

async function loadManifest(path: string): Promise<MediaManifest> {
  try {
    const raw = await readFile(path, "utf8")
    return parseManifest(JSON.parse(raw))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { version: 1, generatedAt: new Date().toISOString(), records: {} }
    }
    throw error
  }
}

async function deriveOne(item: InputItem, store: MediaStore): Promise<MediaRecord> {
  const nowIso = new Date().toISOString()
  const base = {
    contract: item.contract.toLowerCase(),
    tokenId: item.tokenId,
    sourceUrl: item.sourceUrl,
    attemptCount: 1,
    lastAttemptAt: nowIso,
    nextAttemptAt: null,
  }
  try {
    const derived = await deriveMedia(item.sourceUrl)
    const key = derivativeKey(DERIVATIVE_PREFIX, derived.sha256, "webp")
    const { url } = await store.put(key, derived.bytes, derived.mime)
    return {
      ...base,
      resolvedUrl: derived.resolvedUrl,
      kind: derived.kind,
      status: "ready",
      thumbnailUrl: derived.kind === "image" ? url : null,
      posterUrl: derived.kind === "video" ? url : null,
      width: derived.width,
      height: derived.height,
      durationMs: derived.durationMs,
      mimeType: derived.sourceMime,
      sourceBytes: derived.sourceBytes,
      derivativeBytes: derived.bytes.length,
      sourceSha256: derived.sourceSha256,
      derivativeSha256: derived.sha256,
      preferredGateway: derived.preferredGateway,
      lastError: null,
      lastSuccessAt: nowIso,
    }
  } catch (error) {
    return {
      ...base,
      resolvedUrl: null,
      kind: "unknown",
      status: "failed",
      thumbnailUrl: null,
      posterUrl: null,
      width: null,
      height: null,
      durationMs: null,
      mimeType: null,
      sourceBytes: null,
      derivativeBytes: null,
      sourceSha256: null,
      derivativeSha256: null,
      preferredGateway: null,
      lastError: (error as Error).message.slice(0, 1_000),
      lastSuccessAt: null,
    }
  }
}

async function runPool<T>(items: T[], concurrency: number, worker: (item: T) => Promise<void>) {
  let index = 0
  async function next(): Promise<void> {
    const i = index++
    if (i >= items.length) return
    await worker(items[i])
    return next()
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, next))
}

/**
 * `pnd-media derive`: reads a JSON array of `{contract, tokenId, sourceUrl}`,
 * derives each item's thumbnail/poster into a local file store, and merges
 * the results into a manifest. A per-item failure is recorded as a failed
 * record; it never aborts the run.
 */
export async function main(argv: string[]): Promise<void> {
  const [command, ...rest] = argv
  if (command !== "derive") {
    console.error(USAGE)
    process.exitCode = 1
    return
  }
  const { values } = parseArgs({
    args: rest,
    options: {
      input: { type: "string" },
      out: { type: "string" },
      "public-base": { type: "string" },
      manifest: { type: "string" },
    },
  })
  const { input: inputPath, out: outDir, manifest: manifestPath } = values
  const publicBase = values["public-base"]
  if (!inputPath || !outDir || !publicBase || !manifestPath) {
    console.error(USAGE)
    process.exitCode = 1
    return
  }

  const items = JSON.parse(await readFile(inputPath, "utf8")) as InputItem[]
  const store = fileStore({ dir: outDir, publicBase })
  const manifest = await loadManifest(manifestPath)

  await runPool(items, CONCURRENCY, async (item) => {
    const record = await deriveOne(item, store)
    manifest.records[recordKey(record.contract, record.tokenId)] = record
  })

  manifest.generatedAt = new Date().toISOString()
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2))
  console.log(`wrote ${Object.keys(manifest.records).length} records to ${manifestPath}`)
}
