/**
 * Provenance record + Arweave path manifest for the capture tool. Pure
 * functions plus a tiny JSON-file store; no network, no chain, no Irys
 * client. `CAPTURE_OUT_DIR/manifest.<chain>.json` is the source of truth
 * for "already captured" on later runs.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import type { CaptureChain, IrysNetwork } from "./config.ts"

export const MANIFEST_VERSION = "0.1.0"

export interface CapturedTokenRecord {
  tokenId: number
  seed: string
  owner: string
  sha256: string
  itemId: string
  capturedAt: string
  /** PNG byte size at capture time. Used to estimate upload cost for later
   *  runs when no fresher estimate is available. */
  pngBytes?: number
}

export interface CaptureManifestRecord {
  chain: CaptureChain
  collection: string
  renderAssets: string
  storageNetwork: IrysNetwork
  /** Irys gateway used for both per-item and manifest-path verification. */
  gateway: string
  /** Signed item id of the shared cover PNG; reused across runs once set. */
  coverItemId?: string
  /** Signed item id of the most recently built Arweave path manifest. */
  manifestId?: string
  /** arweave/paths spec version of the manifest at manifestId. */
  manifestVersion?: typeof MANIFEST_VERSION
  /** RenderAssets capture template string derived from manifestId. Set only
   *  after the onchain setCaptureTemplate write succeeds. */
  template?: string
  /** Highest token id the template covers, written onchain alongside
   *  `template`: the largest N with every id 1..N present in the manifest. */
  templateMaxTokenId?: number
  /** Tx hash of the setCaptureTemplate write that set `template` onchain. */
  templateTxHash?: string
  dryRun?: boolean
  updatedAt: string
  tokens: CapturedTokenRecord[]
}

/** Arweave path manifest, spec version 0.1.0: paths only, resolved by every
 *  Irys gateway and arweave.net. An id not listed in `paths` is unlisted by
 *  design; the onchain coverage bound (RenderAssets.templateMaxTokenIdOf)
 *  is what keeps unlisted ids from ever being requested through the
 *  template, so the manifest needs no fallback entry. */
export interface ArweavePathManifest {
  manifest: "arweave/paths"
  version: typeof MANIFEST_VERSION
  paths: Record<string, { id: string }>
}

export function manifestRecordPath(outDir: string, chain: CaptureChain): string {
  return `${outDir}/manifest.${chain}.json`
}

export function loadManifestRecord(path: string): CaptureManifestRecord | null {
  if (!existsSync(path)) return null
  return JSON.parse(readFileSync(path, "utf8")) as CaptureManifestRecord
}

export function saveManifestRecord(path: string, record: CaptureManifestRecord): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(record, null, 2) + "\n")
}

/**
 * Tokens that still need a capture: everything when there's no prior record
 * or --force, otherwise whatever isn't already in the prior record's token
 * list. Preserves the input order.
 */
export function planCapture<T extends { tokenId: number }>(
  candidates: T[],
  prior: CaptureManifestRecord | null,
  force: boolean,
): T[] {
  if (force || !prior) return candidates
  const done = new Set(prior.tokens.map((t) => t.tokenId))
  return candidates.filter((c) => !done.has(c.tokenId))
}

/**
 * Merges freshly captured tokens into a prior token list. A tokenId already
 * present is replaced by its fresh entry, in place; new tokenIds are
 * appended in the order they appear in `fresh`. No tokenId appears twice.
 */
export function mergeTokenRecords(
  prior: CapturedTokenRecord[],
  fresh: CapturedTokenRecord[],
): CapturedTokenRecord[] {
  const freshById = new Map(fresh.map((t) => [t.tokenId, t]))
  const merged = prior.map((t) => freshById.get(t.tokenId) ?? t)
  const seen = new Set(prior.map((t) => t.tokenId))
  for (const t of fresh) {
    if (!seen.has(t.tokenId)) merged.push(t)
  }
  return merged
}

/** RenderAssets capture template for a manifest id: "{id}" resolves to the
 *  token id (RenderAssets.sol ID_PLACEHOLDER). */
export function captureTemplate(manifestId: string): string {
  return `ar://${manifestId}/{id}.png`
}

/**
 * The onchain coverage bound: the largest N such that every token id 1..N
 * is present in `tokenIds`. A gap stops the bound at the id before the gap
 * (e.g. ids {1,2,4,5} bound at 2), even though the manifest below still
 * carries paths for 4 and 5 -- they just aren't reachable through the
 * template until the gap is filled and a new bound is written.
 */
export function computeCoverageBound(tokenIds: Iterable<number>): number {
  const present = new Set(tokenIds)
  let bound = 0
  while (present.has(bound + 1)) bound++
  return bound
}

/**
 * Builds the arweave/paths manifest for every captured token (this run plus
 * all prior ones). No fallback and no index: ids outside the onchain
 * coverage bound simply aren't listed.
 */
export function buildArweavePathManifest(tokens: { tokenId: number; itemId: string }[]): ArweavePathManifest {
  const paths: Record<string, { id: string }> = {}
  for (const t of tokens) {
    paths[`${t.tokenId}.png`] = { id: t.itemId }
  }
  return { manifest: "arweave/paths", version: MANIFEST_VERSION, paths }
}

/**
 * Local structural check of a built manifest, run before it's signed and
 * uploaded. Every path must map to an item id that was actually verified
 * for that token, path names must be exactly "<tokenId>.png", and no item
 * id may appear twice.
 */
export function assertManifestStructure(
  manifest: ArweavePathManifest,
  tokens: { tokenId: number; itemId: string }[],
): void {
  if (manifest.manifest !== "arweave/paths") {
    throw new Error(`manifest.manifest must be "arweave/paths", got "${manifest.manifest}"`)
  }
  if (manifest.version !== MANIFEST_VERSION) {
    throw new Error(`manifest.version must be "${MANIFEST_VERSION}", got "${manifest.version}"`)
  }
  const verifiedItemIdByTokenId = new Map(tokens.map((t) => [t.tokenId, t.itemId]))
  const seenIds = new Set<string>()
  for (const [path, entry] of Object.entries(manifest.paths)) {
    const m = /^(\d+)\.png$/.exec(path)
    if (!m) throw new Error(`manifest path "${path}" is not "<tokenId>.png"`)
    const tokenId = Number(m[1])
    const verified = verifiedItemIdByTokenId.get(tokenId)
    if (verified === undefined) {
      throw new Error(`manifest path "${path}" has no verified upload for token ${tokenId}`)
    }
    if (entry.id !== verified) {
      throw new Error(`manifest path "${path}" item id "${entry.id}" does not match the verified upload "${verified}"`)
    }
    if (seenIds.has(entry.id)) throw new Error(`manifest has duplicate item id "${entry.id}"`)
    seenIds.add(entry.id)
  }
}

export type ResumeStage = "full" | "verify-manifest" | "done"

/**
 * Where a run should start given the prior record and how many tokens still
 * need capture. "full" renders and re-uploads; "verify-manifest" skips
 * straight to manifest verification and the chain write, reusing a
 * manifest that was really uploaded (not just dry-run computed) in a prior
 * run; "done" means an existing onchain template already covers everything
 * in scope.
 */
export function resumeStage(prior: CaptureManifestRecord | null, toCaptureCount: number): ResumeStage {
  if (toCaptureCount > 0 || !prior) return "full"
  if (prior.template) return "done"
  if (prior.manifestId && !prior.dryRun) return "verify-manifest"
  return "full"
}
