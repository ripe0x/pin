/**
 * Resolve tokenURI + IPFS for newly-discovered tokens. Ports the loop
 * body from apps/metadata-warmer/src/index.ts (folded into worker).
 *
 * Re-resolve policy: rows with all-null payload AND fetched_at older
 * than RETRY_AFTER (7 days) get one re-attempt; IPFS gateways
 * sometimes recover stale pins.
 */
import { sql } from "../db.ts"
import { client } from "../rpc.ts"
import { resolveTokenMetadata } from "@pin/token-metadata"
import type { TaskResult } from "../scheduler.ts"

const BATCH_SIZE = Number(process.env.WARMER_BATCH_SIZE ?? "50")
const CONCURRENCY = Number(process.env.WARMER_CONCURRENCY ?? "4")
const RETRY_AFTER = process.env.WARMER_RETRY_AFTER ?? "7 days"

const INDEXER_SCHEMA = (process.env.INDEXER_SCHEMA ?? "ponder_v1").replace(
  /[^a-zA-Z0-9_]/g, "",
)

type Candidate = { contract: string; tokenId: string }

async function findCandidates(): Promise<Candidate[]> {
  // Tokens we've discovered that don't yet have a metadata row (or
  // have a stale all-null row).
  //
  // Spend gate: every candidate's creator must be in known_artists.
  // Without this gate the task would warm metadata for all 50K+ SR V2
  // shared-1/1 mints (and every FND shared-1/1 mint), violating the
  // architectural invariant that known_artists is the spend ceiling
  // for all worker external spend. Tokens whose creator isn't a known
  // artist still resolve on-demand via web's
  // resolveTokenMetadataDirect with write-through, so an
  // ungated-creator's /artist page still works when visited — we just
  // don't pre-warm pessimistically.
  //
  // Probe for Ponder tables first: on a fresh deploy the indexer
  // hasn't run yet. Falling back to `artist_tokens` alone (which is
  // already gated at the scanner level) lets the worker make progress
  // during the Ponder backfill window.
  const ponderReady = (await sql`
    SELECT EXISTS (SELECT 1 FROM information_schema.tables
      WHERE table_schema = ${INDEXER_SCHEMA} AND table_name = 'fnd_artist_tokens'
    ) AS ready
  `) as Array<{ ready: boolean }>

  const cte = ponderReady[0]?.ready
    ? `WITH discovered AS (
         -- FND shared-1/1 mints: only for creators in known_artists.
         SELECT lower(t.contract) AS contract, t.token_id::text AS token_id
           FROM ${INDEXER_SCHEMA}.fnd_artist_tokens t
           JOIN known_artists k ON k.address = lower(t.creator)
         UNION
         -- SR V2 shared-1/1 mints: only for creators in known_artists.
         SELECT lower(t.contract), t.token_id::text
           FROM ${INDEXER_SCHEMA}.srv2_artist_tokens t
           JOIN known_artists k ON k.address = lower(t.creator)
         UNION
         -- Worker-owned artist_tokens: already gated at scanner level
         -- but JOIN defensively in case a row pre-dates a gate change.
         SELECT lower(t.contract), t.token_id
           FROM artist_tokens t
           JOIN known_artists k ON k.address = t.artist
       )`
    : `WITH discovered AS (
         SELECT lower(t.contract) AS contract, t.token_id
           FROM artist_tokens t
           JOIN known_artists k ON k.address = t.artist
       )`

  // Quote alias as "tokenId" so postgres.js doesn't lowercase the
  // column (snake_case → JS object key mismatch caused
  // BigInt(undefined) at one point).
  const rows = (await sql.unsafe(
    `${cte}
     SELECT d.contract, d.token_id AS "tokenId"
     FROM discovered d
     LEFT JOIN token_metadata m
       ON m.contract = d.contract AND m.token_id = d.token_id
     WHERE m.contract IS NULL
        OR (
          m.name IS NULL AND m.description IS NULL
          AND m.image_url IS NULL AND m.animation_url IS NULL
          AND m.fetched_at < NOW() - INTERVAL '${RETRY_AFTER.replace(/'/g, "''")}'
        )
     LIMIT ${BATCH_SIZE}`,
  )) as Array<Candidate>
  return rows
}

async function processOne(c: Candidate): Promise<"resolved" | "empty"> {
  try {
    const meta = await resolveTokenMetadata(client, c.contract, c.tokenId)
    await sql`
      INSERT INTO token_metadata
        (contract, token_id, name, description, image_url, animation_url, raw_uri, fetched_at)
      VALUES
        (${c.contract}, ${c.tokenId},
         ${meta?.name ?? null}, ${meta?.description ?? null},
         ${meta?.image ?? null}, ${meta?.animation_url ?? null},
         ${meta?.uri ?? null}, NOW())
      ON CONFLICT (contract, token_id) DO UPDATE SET
        name = EXCLUDED.name, description = EXCLUDED.description,
        image_url = EXCLUDED.image_url, animation_url = EXCLUDED.animation_url,
        raw_uri = EXCLUDED.raw_uri, fetched_at = NOW()
    `
    const hasContent = meta && (meta.name || meta.description || meta.image || meta.animation_url)
    return hasContent ? "resolved" : "empty"
  } catch (err) {
    console.error(`[warm-metadata] ${c.contract}/${c.tokenId}:`, err)
    // Write the empty sentinel so we don't retry on every tick.
    await sql`
      INSERT INTO token_metadata
        (contract, token_id, name, description, image_url, animation_url, raw_uri, fetched_at)
      VALUES (${c.contract}, ${c.tokenId}, NULL, NULL, NULL, NULL, NULL, NOW())
      ON CONFLICT (contract, token_id) DO UPDATE SET fetched_at = NOW()
    `.catch(() => {})
    return "empty"
  }
}

export async function warmMetadata(): Promise<TaskResult> {
  const candidates = await findCandidates()
  if (candidates.length === 0) return { scopeCount: 0, rpcCalls: 0, rowsWritten: 0 }

  let rpcCalls = 0
  let rowsWritten = 0

  // Bounded concurrency. IPFS gateways throttle above ~5.
  for (let i = 0; i < candidates.length; i += CONCURRENCY) {
    const slice = candidates.slice(i, i + CONCURRENCY)
    const results = await Promise.all(slice.map(processOne))
    rpcCalls += slice.length * 2 // rough: tokenURI + IPFS fetch
    rowsWritten += results.length
  }

  return { scopeCount: candidates.length, rpcCalls, rowsWritten }
}
