import "server-only"
import type { Address } from "viem"
import { PLATFORMS_BY_ID } from "./platforms"
import type { ArtistTokenRef, PlatformId } from "./platforms/types"

/**
 * Multi-platform inventory of an artist's created tokens, used by the
 * Artist Dependency Report. Foundation data already comes from the
 * Ponder indexer (`getArtistContractMap`); this module fills in the
 * non-Foundation platforms via the existing `PlatformAdapter.
 * discoverArtistTokens()` interface. Each adapter already maintains a
 * 30-day Postgres lazy cache (`lazy_<id>_artist_tokens`), so cold
 * scans pay the RPC bill once and warm scans return rows directly.
 *
 * A hard per-platform timeout (~4s) prevents any single slow adapter
 * from gating the report. Failed platforms surface in `platformErrors`
 * so the UI can render an honest "Couldn't reach SuperRare in time"
 * note rather than silently dropping tokens.
 *
 * `sovereign` is skipped because its adapter doesn't mint tokens (its
 * `discoverArtistTokens` returns []); `foundation` is skipped because
 * Ponder is the source of truth for Foundation, and including the
 * adapter here would double-count.
 */

const FAN_OUT_PLATFORMS: PlatformId[] = [
  "manifold",
  "superrareV2",
  "transient",
]

const PLATFORM_TIMEOUT_MS = 4_000

export type PlatformError = {
  platform: PlatformId
  reason: "timeout" | "error"
  message?: string
}

export type InventoryContract = {
  contract: string
  tokenCount: number
  platform: PlatformId
  collectionName: string | null
}

export type ArtistInventory = {
  /** All tokens returned across the fanned-out platforms. */
  tokens: ArtistTokenRef[]
  /** Per-contract aggregation, sorted by tokenCount desc. */
  contracts: InventoryContract[]
  /** Platforms that timed out or threw. */
  platformErrors: PlatformError[]
}

type PlatformResult =
  | { ok: true; platform: PlatformId; tokens: ArtistTokenRef[] }
  | { ok: false; error: PlatformError }

async function callPlatformWithTimeout(
  platformId: PlatformId,
  artist: Address,
): Promise<PlatformResult> {
  const adapter = PLATFORMS_BY_ID[platformId]
  if (!adapter) {
    return {
      ok: false,
      error: { platform: platformId, reason: "error", message: "no adapter" },
    }
  }

  let timer: ReturnType<typeof setTimeout> | undefined
  const timeoutP = new Promise<PlatformResult>((resolve) => {
    timer = setTimeout(() => {
      resolve({
        ok: false,
        error: { platform: platformId, reason: "timeout" },
      })
    }, PLATFORM_TIMEOUT_MS)
  })
  const fetchP: Promise<PlatformResult> = adapter
    .discoverArtistTokens(artist)
    .then((tokens) => ({ ok: true as const, platform: platformId, tokens }))
    .catch((e) => ({
      ok: false as const,
      error: {
        platform: platformId,
        reason: "error" as const,
        message: (e as Error).message,
      },
    }))

  try {
    return await Promise.race([fetchP, timeoutP])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

export async function getArtistInventory(
  address: string,
): Promise<ArtistInventory> {
  const artist = address.toLowerCase() as Address

  const results = await Promise.all(
    FAN_OUT_PLATFORMS.map((p) => callPlatformWithTimeout(p, artist)),
  )

  const tokens: ArtistTokenRef[] = []
  const platformErrors: PlatformError[] = []
  for (const r of results) {
    if (r.ok) tokens.push(...r.tokens)
    else platformErrors.push(r.error)
  }

  const map = new Map<string, InventoryContract>()
  for (const t of tokens) {
    const key = t.contract.toLowerCase()
    const existing = map.get(key)
    if (existing) {
      existing.tokenCount++
      // Prefer a non-null collectionName if one comes in later.
      if (!existing.collectionName && t.collectionName) {
        existing.collectionName = t.collectionName
      }
    } else {
      map.set(key, {
        contract: key,
        tokenCount: 1,
        platform: t.platform,
        collectionName: t.collectionName,
      })
    }
  }

  return {
    tokens,
    contracts: Array.from(map.values()).sort(
      (a, b) => b.tokenCount - a.tokenCount,
    ),
    platformErrors,
  }
}
