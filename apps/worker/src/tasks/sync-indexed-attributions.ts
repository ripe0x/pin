/**
 * Mirror creator evidence from Ponder's fixed shared contracts into the
 * canonical public many-to-many attribution model. Postgres-only, zero RPC.
 */
import { sql } from "../db.ts"
import type { TaskResult } from "../scheduler.ts"

const INDEXER_SCHEMA = (process.env.INDEXER_SCHEMA ?? "indexer_live").replace(
  /[^a-zA-Z0-9_]/g,
  "",
)

export async function syncIndexedAttributions(): Promise<TaskResult> {
  const rows = await sql.unsafe(
    `WITH source AS (
       SELECT lower(creator) AS artist, lower(contract) AS contract,
              token_id::text AS token_id,
              'ponder-foundation-shared'::text AS source,
              'fnd-shared'::text AS platform,
              block_number AS mint_block, log_index::bigint AS mint_log_index
       FROM ${INDEXER_SCHEMA}.fnd_artist_tokens
       UNION ALL
       SELECT lower(creator), lower(contract), token_id::text,
              'ponder-superrare-v2', 'srv2-shared',
              block_number, log_index::bigint
       FROM ${INDEXER_SCHEMA}.srv2_artist_tokens
     )
     INSERT INTO public.work_attributions (
       artist, contract, token_id, source, platform, mint_block, mint_log_index
     )
     SELECT artist, contract, token_id, source, platform, mint_block, mint_log_index
     FROM source
     ON CONFLICT (artist, contract, token_id, source) DO UPDATE SET
       platform = EXCLUDED.platform,
       mint_block = EXCLUDED.mint_block,
       mint_log_index = EXCLUDED.mint_log_index,
       observed_at = NOW()
     WHERE (work_attributions.platform, work_attributions.mint_block,
            work_attributions.mint_log_index)
       IS DISTINCT FROM
           (EXCLUDED.platform, EXCLUDED.mint_block, EXCLUDED.mint_log_index)
     RETURNING 1`,
  )
  return { scopeCount: 2, rpcCalls: 0, rowsWritten: rows.length }
}
