import { NextRequest, NextResponse } from "next/server"
import { sql } from "@/lib/db"

/**
 * Detect and forward-fix drift between Ponder's factory-discovered
 * address set (`ponder_sync.factory_addresses`) and the application's
 * factory-cloned address tables (`pnd_houses`, `fnd_collections`).
 *
 * Background. Ponder 0.16's realtime sync occasionally fails to insert
 * newly-discovered factory clones into `factory_addresses`. The clones'
 * own factory-emit handlers still run (so `pnd_houses` / `fnd_collections`
 * are up to date), and the clones' raw event logs still land in
 * `ponder_sync.logs` (the broader subscription pattern fetches them).
 * But because the addresses aren't in `factory_addresses`, the indexing
 * dispatcher's address filter excludes them — every per-clone handler
 * silently never fires for affected clones.
 *
 * What this cron does. Compares the application tables against
 * `factory_addresses` for both PND (factory_id=1) and FND collections
 * (factory_id=512) and INSERTs any missing rows. **Forward fix only.**
 * Does NOT drop the ponder schema. New events on the now-registered
 * clones will be indexed correctly going forward; past events that
 * fired between clone deploy and this cron's repair are NOT
 * automatically backfilled — they require a manual reindex
 * (`DROP SCHEMA ponder CASCADE`, Ponder auto-restart replays from
 * cached `ponder_sync.logs`).
 *
 * The response includes a `requires_manual_reindex` flag when a repair
 * happened, so the caller can alert.
 *
 * Auth. Reuses `REVALIDATE_SECRET` to match the rest of /api/cron/*.
 *
 * Schedule. Hit nightly (or more often if drift starts recurring) via
 * Netlify scheduled function or external cron:
 *
 *   curl -X POST 'https://pnd.ripe.wtf/api/cron/indexer-drift-check?secret=$REVALIDATE_SECRET'
 *
 * Reference. Bug surfaced 2026-05-06: 29 of 68 PND clones (incl. the
 * Heraldia auction `0x5816a19d…`) were stranded out of factory_addresses.
 * Workaround inserted the missing rows + reindexed; this cron prevents
 * the gap from re-opening.
 */

const PND_FACTORY_ID = 1
const FND_FACTORY_ID = 512
const CHAIN_ID = 1

export async function POST(req: NextRequest) {
  const secret = req.nextUrl.searchParams.get("secret")
  const expected = process.env.REVALIDATE_SECRET
  if (!expected) {
    return NextResponse.json(
      { ok: false, error: "REVALIDATE_SECRET env var not set on server" },
      { status: 500 },
    )
  }
  if (secret !== expected) {
    return NextResponse.json(
      { ok: false, error: "unauthorized" },
      { status: 401 },
    )
  }
  if (!sql) {
    return NextResponse.json(
      { ok: false, error: "DATABASE_URL not configured" },
      { status: 500 },
    )
  }

  const db = sql

  // PND: pnd_houses ↔ factory_addresses(factory_id=1)
  const pndMissing = (await db`
    SELECT h.house AS address, h.created_at_block::text AS block_number
    FROM ponder.pnd_houses h
    WHERE NOT EXISTS (
      SELECT 1 FROM ponder_sync.factory_addresses fa
      WHERE fa.factory_id = ${PND_FACTORY_ID} AND lower(fa.address) = h.house
    )
    ORDER BY h.created_at_block::numeric
  `) as Array<{ address: string; block_number: string }>

  // FND: fnd_collections ↔ factory_addresses(factory_id=512)
  const fndMissing = (await db`
    SELECT c.collection AS address, c.created_at_block::text AS block_number
    FROM ponder.fnd_collections c
    WHERE NOT EXISTS (
      SELECT 1 FROM ponder_sync.factory_addresses fa
      WHERE fa.factory_id = ${FND_FACTORY_ID} AND lower(fa.address) = c.collection
    )
    ORDER BY c.created_at_block::numeric
  `) as Array<{ address: string; block_number: string }>

  // Insert missing rows. Small batches; the gaps we're patching are
  // dozens at most — full table sweeps are unnecessary.
  // block_number is bigint in Postgres but the postgres-js TS types
  // don't accept JS bigint as a parameter. Pass as text and cast inside
  // the query — same wire format, valid TS.
  for (const m of pndMissing) {
    await db`
      INSERT INTO ponder_sync.factory_addresses (factory_id, chain_id, block_number, address)
      VALUES (${PND_FACTORY_ID}, ${CHAIN_ID}, ${m.block_number}::bigint, ${m.address})
    `
  }
  for (const m of fndMissing) {
    await db`
      INSERT INTO ponder_sync.factory_addresses (factory_id, chain_id, block_number, address)
      VALUES (${FND_FACTORY_ID}, ${CHAIN_ID}, ${m.block_number}::bigint, ${m.address})
    `
  }

  // Sanity totals so the response answers "are we in sync now?"
  const [totals] = (await db`
    SELECT
      (SELECT count(*)::int FROM ponder.pnd_houses) AS pnd_houses,
      (SELECT count(*)::int FROM ponder_sync.factory_addresses WHERE factory_id = ${PND_FACTORY_ID}) AS pnd_factory_addrs,
      (SELECT count(*)::int FROM ponder.fnd_collections) AS fnd_collections,
      (SELECT count(*)::int FROM ponder_sync.factory_addresses WHERE factory_id = ${FND_FACTORY_ID}) AS fnd_factory_addrs
  `) as [
    {
      pnd_houses: number
      pnd_factory_addrs: number
      fnd_collections: number
      fnd_factory_addrs: number
    },
  ]

  const repaired = pndMissing.length + fndMissing.length
  return NextResponse.json({
    ok: true,
    repaired,
    requires_manual_reindex: repaired > 0,
    detail: {
      pnd: { missing_inserted: pndMissing.length, addresses: pndMissing.map((r) => r.address) },
      fnd: { missing_inserted: fndMissing.length, addresses: fndMissing.map((r) => r.address) },
    },
    totals,
    note:
      repaired > 0
        ? "factory_addresses backfilled — new events on these clones will index going forward, but past missed events require a manual reindex (DROP SCHEMA ponder CASCADE; Ponder auto-restarts and replays from ponder_sync.logs)."
        : "no drift detected.",
  })
}
