/**
 * Resolve tokenURI + IPFS for newly-discovered tokens. Ports the loop
 * body from apps/metadata-warmer/src/index.ts (folded into worker).
 *
 * Re-resolve policy: a row is "successfully fetched" iff it carries actual
 * content (any of name/description/image_url/animation_url). A content-less
 * row is a failed fetch — a brand-new mint that hadn't propagated yet, or a
 * gateway error/garbage 200 (which the resolver may have stamped with a
 * bogus `raw_uri`) — so we retry it on a short cadence (RETRY_AFTER, default
 * 5 min) until it resolves. Rows with content are final and never re-fetched,
 * so good metadata is fetched exactly once. (We deliberately do NOT trust
 * `raw_uri` as the success signal — it gets set on non-metadata responses.)
 */
import { sql } from "../db.ts"
import { client } from "../rpc.ts"
import { resolveTokenMetadataWithState } from "@pin/token-metadata"
import type { TaskResult } from "../scheduler.ts"

const BATCH_SIZE = Number(process.env.WARMER_BATCH_SIZE ?? "50")
const CONCURRENCY = Number(process.env.WARMER_CONCURRENCY ?? "4")
const RETRY_AFTER = process.env.WARMER_RETRY_AFTER ?? "5 minutes"

const INDEXER_SCHEMA = (process.env.INDEXER_SCHEMA ?? "indexer_live").replace(
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
  const tableExists = async (name: string) =>
    (
      (await sql`
        SELECT EXISTS (SELECT 1 FROM information_schema.tables
          WHERE table_schema = ${INDEXER_SCHEMA} AND table_name = ${name}
        ) AS ready
      `) as Array<{ ready: boolean }>
    )[0]?.ready ?? false

  const ponderReady = await tableExists("fnd_artist_tokens")
  // Surface collections (PND-native onchain works) live in a separate
  // Ponder deploy that can trail the others; gate the branch on the
  // table existing so a fresh/older schema doesn't error the query.
  const surfaceReady = await tableExists("collection_mints")

  // Surface mints carry a contiguous [first_token_id, +quantity) range
  // per event; expand to one row per token. Gated on the collection
  // owner (the artist) being in known_artists, the same spend ceiling as
  // every other branch. Their tokenURI is an onchain document — for an
  // onchain-SVG work the `image` field is a small self-contained SVG that
  // the shared resolver stores like any other image, giving the feed a
  // per-token thumbnail without a render-time chain read.
  const surfaceBranch = surfaceReady
    ? `
         UNION
         SELECT lower(cm.collection) AS contract, gs.token_id::text
           FROM ${INDEXER_SCHEMA}.collection_mints cm
           JOIN ${INDEXER_SCHEMA}.collections c ON c.collection = cm.collection
           JOIN known_artists k ON k.address = lower(c.owner)
           CROSS JOIN LATERAL generate_series(
             cm.first_token_id::bigint,
             cm.first_token_id::bigint + cm.quantity::bigint - 1
           ) AS gs(token_id)`
    : ""

  const cte = ponderReady
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
           JOIN known_artists k ON k.address = t.artist${surfaceBranch}
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
          -- Burned/nonexistent is permanent — never re-attempt it.
          AND NOT m.burned
          AND m.fetched_at < NOW() - INTERVAL '${RETRY_AFTER.replace(/'/g, "''")}'
        )
     LIMIT ${BATCH_SIZE}`,
  )) as Array<Candidate>
  return rows
}

async function processOne(c: Candidate): Promise<"resolved" | "empty"> {
  try {
    const { metadata: meta, exists } = await resolveTokenMetadataWithState(
      client,
      c.contract,
      c.tokenId,
    )
    // exists === false is a definitive burn; null is indeterminate (leave the
    // flag at its default false so we don't hide a token we couldn't confirm).
    const burned = exists === false
    await sql`
      INSERT INTO token_metadata
        (contract, token_id, name, description, image_url, animation_url, raw_uri, burned, fetched_at)
      VALUES
        (${c.contract}, ${c.tokenId},
         ${meta?.name ?? null}, ${meta?.description ?? null},
         ${meta?.image ?? null}, ${meta?.animation_url ?? null},
         ${meta?.uri ?? null}, ${burned}, NOW())
      ON CONFLICT (contract, token_id) DO UPDATE SET
        name = EXCLUDED.name, description = EXCLUDED.description,
        image_url = EXCLUDED.image_url, animation_url = EXCLUDED.animation_url,
        raw_uri = EXCLUDED.raw_uri, burned = EXCLUDED.burned, fetched_at = NOW()
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
