import "server-only"
import {
  createPublicClient,
  http,
  type Address,
  type ContractFunctionParameters,
  type PublicClient,
} from "viem"
import { mainnet } from "viem/chains"
import { pgCache } from "./pg-cache"
import type { MintCollection } from "./mint-collections"
import type { PhaseWindow } from "./mint-phases"
import {
  getHomageConfig,
  getHomageOutstandingCount,
  getHomageOutstandingIds,
} from "./homage-queries"
import { overlayPhaseWindows, overallStartFromWindows } from "./mint-snapshot-overlay"

/**
 * Live, cached onchain reads for the generic ERC-721 mint surface. Modeled on
 * `editions-onchain.ts`: one short-TTL `pgCache` around a batched multicall per
 * read, the canonical mainnet chain object so viem resolves Multicall3 (the
 * fork forks mainnet, so it's present there too), and graceful failure on
 * minimalist/older contracts (every read tolerates a revert).
 *
 * Decision (locked with the user): cached live reads ONLY — no indexer, no
 * worker, no getLogs. Mint provenance that needs events (the original minter,
 * the mint tx) is intentionally out of scope; the "recent" surfaces show
 * current onchain state (occupancy), which is what these reads can serve
 * cheaply.
 */

const FORK_MODE = process.env.NEXT_PUBLIC_USE_LOCAL_RPC === "1"

function getClient(): PublicClient {
  if (FORK_MODE) {
    const url = process.env.NEXT_PUBLIC_ANVIL_RPC_URL || "http://127.0.0.1:8545"
    return createPublicClient({ chain: mainnet, transport: http(url) })
  }
  const explicit = process.env.ALCHEMY_MAINNET_URL
  if (explicit) return createPublicClient({ chain: mainnet, transport: http(explicit) })
  const key = process.env.ALCHEMY_API_KEY
  const url =
    key && !key.startsWith("set-")
      ? `https://eth-mainnet.g.alchemy.com/v2/${key}`
      : "https://eth.drpc.org"
  return createPublicClient({ chain: mainnet, transport: http(url) })
}

const lc = (a: string) => a.toLowerCase()

/**
 * Live-metadata TTLs (2.7). When a collection declares `liveMetadata`, its
 * tokenURI output changes with onchain state, so reads are cached at the
 * declared short TTL and NEVER persisted as canonical — everything below is
 * pgCache-only (expiring rows), no writes to any token-metadata table. The
 * gallery grid multiplies the TTL: a slightly stale status color across a
 * large grid is an accepted tradeoff for not re-rendering N tokens per view.
 */
function pieceTtlSec(desc: MintCollection, fallback: number): number {
  return desc.liveMetadata?.ttlSec ?? fallback
}
function galleryTtlSec(desc: MintCollection): number {
  return desc.liveMetadata ? Math.max(desc.liveMetadata.ttlSec * 4, 120) : 30
}

type CallResult = { status: "success"; result: unknown } | { status: "failure"; result?: undefined }

/**
 * Multicall that degrades gracefully to individual `eth_call`s. On production
 * mainnet, Multicall3 is present and this is one batched call. On a local anvil
 * fork whose upstream prunes archive state (e.g. forked from publicnode, then
 * the head moves on), the lazy fetch of Multicall3's own code 403s, so the
 * aggregate returns failures (or throws) even though direct calls to the
 * locally-deployed contracts still work. We retry only the failed entries
 * individually — zero extra cost when the multicall succeeds.
 */
async function multicallResilient(
  client: PublicClient,
  contracts: ContractFunctionParameters[],
): Promise<CallResult[]> {
  let results: CallResult[]
  try {
    results = (await client.multicall({ allowFailure: true, contracts })) as CallResult[]
  } catch {
    results = contracts.map(() => ({ status: "failure" }))
  }
  await Promise.all(
    results.map(async (r, i) => {
      if (r.status === "success") return
      try {
        results[i] = { status: "success", result: await client.readContract(contracts[i]) }
      } catch {
        /* leave as failure */
      }
    }),
  )
  return results
}

// ── data-URI metadata decoding (onchain generative tokenURI) ─────────────────

/**
 * Decode a `data:application/json[;base64],…` tokenURI body into an object.
 * Onchain renderers (Vouch) emit base64 JSON; the utf8/plain forms are handled
 * too for other contracts. Returns null on any non-data or malformed URI.
 */
function decodeDataUriJson(uri: string): Record<string, unknown> | null {
  if (!uri.startsWith("data:")) return null
  const comma = uri.indexOf(",")
  if (comma === -1) return null
  const meta = uri.slice(5, comma)
  const raw = uri.slice(comma + 1)
  try {
    const body = /;base64/i.test(meta)
      ? Buffer.from(raw, "base64").toString("utf8")
      : decodeURIComponent(raw)
    return JSON.parse(body) as Record<string, unknown>
  } catch {
    return null
  }
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null
}

export type TokenArt = {
  imageUrl: string
  animationUrl: string | null
  name: string | null
  description: string | null
}

function artFromJson(json: Record<string, unknown> | null): TokenArt {
  return {
    imageUrl: str(json?.image) ?? str(json?.image_url) ?? "",
    animationUrl: str(json?.animation_url) ?? str(json?.animation),
    name: str(json?.name),
    description: str(json?.description),
  }
}

// ── snapshot (price / supply / window) ───────────────────────────────────────

export type MintSnapshot = {
  /** All fields are decimal strings (bigint-safe across the RSC boundary). */
  priceWei: string // "0" for quote-priced collections (resolved client-side)
  minted: string
  cap: string // "0" == uncapped
  mintStart: string // unix seconds; "0" == no explicit start
  mintEnd: string // unix seconds; "0" == open-ended
  /**
   * Present only for phased descriptors: raw per-phase window bounds, in
   * descriptor order. Resolution against a clock (which phase is live, what
   * opens next) is `resolvePhaseState` in mint-phases.ts — pure, so the
   * server page and MintPanel's ticking clock share it with zero extra RPC.
   */
  phases?: PhaseWindow[]
}

/**
 * Indexer-first overlay (Phase 4.2). For a collection whose schedule + supply
 * are indexed (`provenanceSource`), prefer the Postgres values over the RPC
 * snapshot: the phase windows come from `homage_config` and `minted` becomes
 * the live OUTSTANDING count from `homage_tokens`. Both degrade to the RPC base
 * when the tables are absent/empty (pre-deploy, fork, or a slow indexer), so
 * the RPC path is never removed — it's the fallback and the fork-mode path.
 *
 * Overlaying only REPLACES values the indexer can serve more cheaply/correctly;
 * price stays a client-side quote and the RPC base still carries the phase
 * shape (labels/keys) so a partially-synced config doesn't drop phases.
 */
async function applyIndexerSnapshotOverlay(
  desc: MintCollection,
  base: MintSnapshot,
): Promise<MintSnapshot> {
  if (desc.provenanceSource !== "homage") return base

  const [config, outstanding] = await Promise.all([
    getHomageConfig(desc.address).catch(() => null),
    getHomageOutstandingCount(desc.address).catch(() => null),
  ])

  let phases = base.phases
  // Map the indexed schedule onto the descriptor's phase windows by the getter
  // name each phase declares (claimStart / allowlistStart / publicStart). A
  // null indexed value leaves the RPC value in place (partial sync). Pure math
  // lives in mint-snapshot-overlay.ts (unit-tested).
  if (config && base.phases && desc.phases) {
    phases = overlayPhaseWindows(
      base.phases,
      desc.phases.map((p) => p.window),
      config,
    )
  }

  const overallStart = phases
    ? overallStartFromWindows(phases, base.mintStart)
    : base.mintStart

  return {
    ...base,
    // Live outstanding count wins when the indexer has it (churn-aware); else
    // the RPC totalMinted from the base snapshot.
    minted: outstanding != null ? String(outstanding) : base.minted,
    mintStart: phases ? overallStart : base.mintStart,
    phases,
  }
}

export async function getMintSnapshot(desc: MintCollection): Promise<MintSnapshot> {
  const base = await getMintSnapshotRpc(desc)
  return applyIndexerSnapshotOverlay(desc, base)
}

/**
 * The RPC/cached snapshot (price / supply / window) — the pre-deploy + fork
 * path, and the fallback the indexer overlay degrades to. Named `…Rpc` because
 * `getMintSnapshot` layers the indexer-first overlay on top (Phase 4.2).
 */
async function getMintSnapshotRpc(desc: MintCollection): Promise<MintSnapshot> {
  return pgCache(`mint-snap:${lc(desc.address)}`, 20, async () => {
    const client = getClient()
    const base = { address: desc.address, abi: desc.abi } as const

    const calls: ContractFunctionParameters[] = [{ ...base, functionName: desc.mintedFn }]
    let priceIdx = -1
    let capIdx = -1
    let startIdx = -1
    let endIdx = -1
    if (desc.price.kind === "getter") {
      priceIdx = calls.length
      calls.push({ ...base, functionName: desc.price.fn })
    }
    if (desc.cap.kind === "getter") {
      capIdx = calls.length
      calls.push({ ...base, functionName: desc.cap.fn })
    }
    // Phases supersede the single window: read every phase's start/end getter
    // (deduped — a phase's endFn is conventionally the next phase's startFn)
    // in this SAME multicall, so a phased schedule costs zero extra requests.
    const phaseGetterIdx = new Map<string, number>()
    if (desc.phases) {
      for (const p of desc.phases) {
        for (const fn of [p.window.startFn, p.window.endFn]) {
          if (!fn || phaseGetterIdx.has(fn)) continue
          phaseGetterIdx.set(fn, calls.length)
          calls.push({ ...base, functionName: fn })
        }
      }
    } else {
      if (
        desc.window.kind === "start-duration" ||
        desc.window.kind === "start-end" ||
        desc.window.kind === "start-only"
      ) {
        startIdx = calls.length
        calls.push({ ...base, functionName: desc.window.startFn })
      }
      if (desc.window.kind === "start-end") {
        endIdx = calls.length
        calls.push({ ...base, functionName: desc.window.endFn })
      }
    }

    const res = await multicallResilient(client, calls)
    const val = (i: number): bigint =>
      i >= 0 && res[i]?.status === "success" ? BigInt(res[i].result as bigint) : 0n

    const minted = val(0)
    const priceWei =
      desc.price.kind === "const"
        ? desc.price.wei
        : desc.price.kind === "quote"
          ? 0n // quote-priced: MintPanel resolves msg.value via the provider
          : val(priceIdx)
    const cap =
      desc.cap.kind === "const"
        ? desc.cap.value
        : desc.cap.kind === "open"
          ? 0n
          : val(capIdx)

    if (desc.phases) {
      // A failed/absent getter reads as 0n via val(), i.e. "unscheduled" —
      // exactly the closed-window semantics mint-phases.ts documents.
      const g = (fn: string | undefined): bigint =>
        fn !== undefined ? val(phaseGetterIdx.get(fn) ?? -1) : 0n
      const phases: PhaseWindow[] = desc.phases.map((p) => ({
        key: p.key,
        label: p.label,
        start: g(p.window.startFn).toString(),
        end: g(p.window.endFn).toString(),
      }))
      // Overall bounds for consumers that don't understand phases: opens at
      // the earliest scheduled phase, and (phases being open-ended) no close.
      const starts = phases.map((p) => BigInt(p.start)).filter((s) => s > 0n)
      const overallStart = starts.length > 0 ? starts.reduce((a, b) => (b < a ? b : a)) : 0n
      return {
        priceWei: priceWei.toString(),
        minted: minted.toString(),
        cap: cap.toString(),
        mintStart: overallStart.toString(),
        mintEnd: "0",
        phases,
      }
    }

    const start = startIdx >= 0 ? val(startIdx) : 0n
    let end = 0n
    if (desc.window.kind === "start-duration")
      end = start > 0n ? start + BigInt(desc.window.durationSec) : 0n
    else if (desc.window.kind === "start-end") end = val(endIdx)

    return {
      priceWei: priceWei.toString(),
      minted: minted.toString(),
      cap: cap.toString(),
      mintStart: start.toString(),
      mintEnd: end.toString(),
    }
  })
}

// ── collection hero art ──────────────────────────────────────────────────────

async function readUriString(
  client: PublicClient,
  address: Address,
  abi: MintCollection["abi"],
  fn: string,
  tokenId: bigint,
): Promise<string | null> {
  try {
    return (await client.readContract({
      address,
      abi,
      functionName: fn,
      args: [tokenId],
    })) as string
  } catch {
    return null
  }
}

export async function getCollectionArt(desc: MintCollection): Promise<TokenArt | null> {
  return pgCache(`mint-art:${lc(desc.address)}`, pieceTtlSec(desc, 90), async () => {
    const client = getClient()
    if (desc.hero.kind === "static") {
      return {
        imageUrl: desc.hero.url,
        animationUrl: null,
        name: desc.name,
        description: desc.description ?? null,
      }
    }
    const uri =
      desc.hero.kind === "renderer-contract"
        ? await readUriString(client, desc.hero.address, desc.hero.abi, desc.hero.fn, desc.hero.tokenId)
        : await readUriString(client, desc.address, desc.abi, "tokenURI", desc.hero.tokenId)
    if (!uri) return null
    return artFromJson(decodeDataUriJson(uri))
  })
}

// ── shared-aggregate stat block (Vouch cube getters) ─────────────────────────

export type AggregateStats = {
  trustBps: number
  coherenceBps: number
  thresholdBps: number
  activeCount: number
  maintained: boolean
}

export async function getAggregateStats(desc: MintCollection): Promise<AggregateStats | null> {
  if (!desc.aggregate) return null
  const agg = desc.aggregate
  return pgCache(`mint-agg:${lc(agg.address)}`, 30, async () => {
    const client = getClient()
    const base = { address: agg.address, abi: agg.abi } as const
    // Cube aggregate shape (CubeRenderer). Only the shared-aggregate layout has
    // these getters, and Vouch is the sole such collection today.
    const calls: ContractFunctionParameters[] = [
      { ...base, functionName: "trustBps" },
      { ...base, functionName: "coherenceBps" },
      { ...base, functionName: "thresholdBps" },
      { ...base, functionName: "activeVouchCount" },
      { ...base, functionName: "relationshipMaintained" },
    ]
    const r = await multicallResilient(client, calls)
    const num = (i: number): number =>
      r[i]?.status === "success" ? Number(r[i].result as bigint) : 0
    return {
      trustBps: num(0),
      coherenceBps: num(1),
      thresholdBps: num(2),
      activeCount: num(3),
      maintained: r[4]?.status === "success" ? Boolean(r[4].result) : false,
    }
  })
}

// ── per-seat states (shared-aggregate grid + recent list) ────────────────────

type RawRenderState = {
  minted: boolean
  active: boolean
  freshnessBps: number | bigint
  expiresAt: bigint
  positionKey: bigint
  owner: Address
}

export type SeatState = {
  tokenId: number
  minted: boolean
  active: boolean
  freshnessBps: number
  owner: Address | null
}

async function readCap(client: PublicClient, desc: MintCollection): Promise<bigint> {
  if (desc.cap.kind === "const") return desc.cap.value
  if (desc.cap.kind === "open") return 0n
  try {
    return BigInt(
      (await client.readContract({
        address: desc.address,
        abi: desc.abi,
        functionName: desc.cap.fn,
      })) as bigint,
    )
  } catch {
    return 0n
  }
}

/**
 * All seats in one `getRenderStates(1, cap)` call (shared-aggregate only). Backs
 * both the seat grid and the "recent" list. Empty array for non-aggregate
 * layouts or if the read fails (e.g. struct shape drifted from the ABI).
 */
export async function getSeatStates(desc: MintCollection): Promise<SeatState[]> {
  if (desc.layout !== "shared-aggregate") return []
  return pgCache(`mint-seats:${lc(desc.address)}`, 30, async () => {
    const client = getClient()
    const cap = await readCap(client, desc)
    if (cap <= 0n) return []
    try {
      const states = (await client.readContract({
        address: desc.address,
        abi: desc.abi,
        functionName: "getRenderStates",
        args: [1n, cap],
      })) as ReadonlyArray<RawRenderState>
      return states.map((s, i) => ({
        tokenId: i + 1,
        minted: s.minted,
        active: s.active,
        freshnessBps: Number(s.freshnessBps),
        owner: s.minted ? s.owner : null,
      }))
    } catch {
      return []
    }
  })
}

// ── single piece (token page) ────────────────────────────────────────────────

export type PieceToken = {
  tokenId: number
  owner: Address | null
  imageUrl: string
  animationUrl: string | null
  name: string | null
  description: string | null
  active: boolean
  expiresAt: number // unix seconds, 0 if not applicable
  freshnessBps: number
  /** Raw `tokenURI(tokenId)` string straight from the contract. */
  rawTokenUri: string
  /** The decoded tokenURI JSON (name, description, image, attributes, …). */
  metadata: Record<string, unknown> | null
}

// ── full collection (gallery) ────────────────────────────────────────────────

export type GalleryToken = {
  tokenId: number
  imageUrl: string
  active: boolean
  owner: Address | null
}

/**
 * Every minted token's thumbnail art for the collection gallery. Fetched
 * on-demand (the gallery toggle), not on the collection page's initial render,
 * so a page view that never opens the gallery pays nothing. For shared-aggregate
 * collections the minted set + active/owner come from one `getRenderStates`
 * read; otherwise we walk 1..totalMinted. `limit` caps the per-request work —
 * large collections should paginate (a follow-up); Vouch's 52 fits in one page.
 */
export async function getCollectionTokens(
  desc: MintCollection,
  limit = 200,
): Promise<GalleryToken[]> {
  return pgCache(`mint-gallery:${lc(desc.address)}`, galleryTtlSec(desc), async () => {
    const client = getClient()

    let minted: Array<{ tokenId: number; active: boolean; owner: Address | null }> = []
    // Indexer-backed gallery (Phase 4.3): for a collection whose outstanding
    // set is indexed, the id list comes from `homage_tokens` — NEVER a live
    // 1..10k enumeration. The tokenURI thumbnails below still read (short-TTL
    // cached), but only for the ids the indexer says exist. Empty result (pre-
    // deploy / unsynced) falls through to the sequential RPC path below.
    const indexedIds =
      desc.provenanceSource === "homage"
        ? await getHomageOutstandingIds(desc.address, limit).catch(() => [])
        : []
    const seats = await getSeatStates(desc)
    if (indexedIds.length > 0) {
      minted = indexedIds.map((tokenId) => ({ tokenId, active: true, owner: null }))
    } else if (seats.length > 0) {
      minted = seats
        .filter((s) => s.minted)
        .map((s) => ({ tokenId: s.tokenId, active: s.active, owner: s.owner }))
    } else {
      // Generic sequential fallback (standard collections, ids 1..totalMinted).
      let total = 0
      try {
        total = Number(
          (await client.readContract({
            address: desc.address,
            abi: desc.abi,
            functionName: desc.mintedFn,
          })) as bigint,
        )
      } catch {
        total = 0
      }
      for (let t = 1; t <= total; t++) minted.push({ tokenId: t, active: true, owner: null })
    }

    minted = minted.slice(0, limit)
    if (minted.length === 0) return []

    const calls: ContractFunctionParameters[] = minted.map((m) => ({
      address: desc.address,
      abi: desc.abi,
      functionName: "tokenURI",
      args: [BigInt(m.tokenId)],
    }))
    const res = await multicallResilient(client, calls)

    return minted
      .map((m, i) => {
        const r = res[i]
        const art = r?.status === "success" ? artFromJson(decodeDataUriJson(r.result as string)) : null
        return {
          tokenId: m.tokenId,
          imageUrl: art?.imageUrl ?? "",
          active: m.active,
          owner: m.owner,
        }
      })
      .filter((t) => t.imageUrl.length > 0)
  })
}

export async function getPieceToken(
  desc: MintCollection,
  tokenId: bigint,
): Promise<PieceToken | null> {
  return pgCache(`mint-piece:${lc(desc.address)}:${tokenId.toString()}`, pieceTtlSec(desc, 45), async () => {
    const client = getClient()
    const base = { address: desc.address, abi: desc.abi } as const
    const life = desc.lifecycle

    const calls: ContractFunctionParameters[] = [
      { ...base, functionName: "tokenURI", args: [tokenId] },
      { ...base, functionName: "ownerOf", args: [tokenId] },
    ]
    let activeIdx = -1
    let expiresIdx = -1
    let freshIdx = -1
    if (life) {
      activeIdx = calls.length
      calls.push({ ...base, functionName: life.activeFn, args: [tokenId] })
      expiresIdx = calls.length
      calls.push({ ...base, functionName: life.expiresFn, args: [tokenId] })
      freshIdx = calls.length
      calls.push({ ...base, functionName: life.freshnessFn, args: [tokenId] })
    }

    const r = await multicallResilient(client, calls)
    if (r[0]?.status !== "success") return null // not minted / no such token
    const rawTokenUri = r[0].result as string
    const metadata = decodeDataUriJson(rawTokenUri)
    const art = artFromJson(metadata)
    const owner = r[1]?.status === "success" ? (r[1].result as Address) : null
    const active =
      activeIdx >= 0 && r[activeIdx]?.status === "success" ? Boolean(r[activeIdx].result) : false
    const expiresAt =
      expiresIdx >= 0 && r[expiresIdx]?.status === "success"
        ? Number(r[expiresIdx].result as bigint)
        : 0
    const freshnessBps =
      freshIdx >= 0 && r[freshIdx]?.status === "success" ? Number(r[freshIdx].result as bigint) : 0

    return {
      tokenId: Number(tokenId),
      owner,
      imageUrl: art.imageUrl,
      animationUrl: art.animationUrl,
      name: art.name,
      description: art.description,
      active,
      expiresAt,
      freshnessBps,
      rawTokenUri,
      metadata,
    }
  })
}
