/**
 * Gateway verification for the capture tool. Every gating check runs
 * against the Irys gateway (per-item bytes, manifest-path bytes, and the
 * 404 that proves an id past the coverage bound is genuinely unlisted);
 * `fetchFn` is injectable so this can be unit tested without a network
 * call, production callers pass the global `fetch`. `probeArweaveServing`
 * is the one non-gating check: an informational HEAD against arweave.net
 * after the chain write, never gating it.
 */
import { mkdirSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import { sha256Hex } from "./hash.ts"

export interface FetchResponseLike {
  ok: boolean
  status: number
  arrayBuffer(): Promise<ArrayBuffer>
}

export type FetchLike = (url: string) => Promise<FetchResponseLike>

function writeBuf(path: string, buf: Buffer): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, buf)
}

/** One GET, no retry: the item is either already on the gateway or it isn't. */
export async function fetchToFile(fetchFn: FetchLike, url: string, path: string): Promise<Buffer> {
  const res = await fetchFn(url)
  if (!res.ok) throw new Error(`GET ${url} -> HTTP ${res.status}`)
  const buf = Buffer.from(await res.arrayBuffer())
  writeBuf(path, buf)
  return buf
}

/** Fetches `url`, writes the bytes to `outPath`, and asserts they hash to
 *  `expectedSha256`. */
export async function verifyBytesAt(
  fetchFn: FetchLike,
  url: string,
  outPath: string,
  expectedSha256: string,
  label: string,
): Promise<void> {
  const buf = await fetchToFile(fetchFn, url, outPath)
  const got = sha256Hex(buf)
  if (got !== expectedSha256) {
    throw new Error(`${label}: ${url} resolved but sha256 mismatch (got ${got}, want ${expectedSha256})`)
  }
}

/** Asserts `url` returns HTTP 404: the id one past the coverage bound has
 *  no manifest path, so the onchain bound is what excludes it, not luck. */
export async function verify404At(fetchFn: FetchLike, url: string, label: string): Promise<void> {
  const res = await fetchFn(url)
  if (res.status !== 404) {
    throw new Error(`${label}: expected HTTP 404 at ${url}, got ${res.status}`)
  }
}

export interface HeadResponseLike {
  status: number
}
export type FetchHeadLike = (url: string) => Promise<HeadResponseLike>

const realFetchHead: FetchHeadLike = (url) => fetch(url, { method: "HEAD" })

/**
 * Non-gating informational probe, run once after the chain write: checks
 * whether arweave.net already serves the manifest for one covered token.
 * Mainnet storage only -- devnet uploads are never seeded to Arweave.
 * Never throws; a network failure is logged and otherwise ignored.
 */
export async function probeArweaveServing(
  manifestId: string,
  tokenId: number,
  fetchHeadFn: FetchHeadLike = realFetchHead,
): Promise<void> {
  const url = `https://arweave.net/${manifestId}/${tokenId}.png`
  try {
    const res = await fetchHeadFn(url)
    console.log(
      res.status === 200
        ? `[capture-thumbnails] arweave.net already serving the manifest (${url})`
        : `[capture-thumbnails] arweave.net not yet serving the manifest (HTTP ${res.status} at ${url}); Irys seeds it on a delay`,
    )
  } catch (err) {
    console.log(`[capture-thumbnails] arweave.net probe failed (non-fatal): ${(err as Error).message}`)
  }
}
