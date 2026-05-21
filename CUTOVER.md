# Cutover: v1 → v2

Strategy is fresh-repo + DNS cut. v1 stays running for a 7-day rollback
window after cutover. The on-chain contracts at
`0xaE712abcA452901A74D1FBC0c3919F2cc060EF9f` (Sovereign factory) and
the Foundation/SR/Catalog/Mint/TL addresses are unchanged — both stacks
read from the same chain state, so running both in parallel is safe.

## Pre-cutover checklist

Provision & ship:
- [ ] Railway project `pnd-v2` created. Postgres add-on attached.
- [ ] Indexer deployed; `_ponder_meta.is_ready=1` after ~1h backfill.
- [ ] Worker deployed; `/health` returns 200; `worker_iterations` shows
      tasks ticking on their cadences.
- [ ] Web deployed; sample artist pages render against v2 Postgres.
- [ ] Env vars set on each service per `.env.example`.

Data-quality spot checks (run against the v2 Postgres):
- [ ] `SELECT COUNT(*) FROM known_artists` matches the v1 count
      (±a few hours of new artists).
- [ ] For 10 sample known artists, `SELECT COUNT(*) FROM artist_tokens
      WHERE artist = $1` matches their gallery size in v1.
- [ ] `SELECT COUNT(*) FROM token_owners WHERE owner IS NULL` = 0.
- [ ] `SELECT COUNT(*) FROM token_metadata WHERE name IS NULL` is small
      (only freshly-discovered or genuinely-empty tokens).
- [ ] `SELECT COUNT(*) FROM ponder_v1.pnd_houses` matches the live
      chain count from `cast call <factory> nextHouseId`.

Shadow domain test:
- [ ] v2 deployed at `v2.<production-domain>` for at least 48h under
      real-ish traffic (link the URL on Twitter, watch metrics).
- [ ] Alchemy CU/day stays bounded by the cost-invariant formula
      (`known_artists × scan_cadence`).
- [ ] No `worker_iterations.ok = false` rows beyond the occasional
      Etherscan blip.

## Cutover (D-day)

1. **Disable v1 writes that would race.** v1's lazy_*-table writes are
   per-cache-miss and don't conflict with v2's worker, but the cron
   refresh-external-indexes-cron is best paused on the v1 side during
   the window to avoid log noise.
   ```
   # Netlify CLI on v1 site
   netlify functions:invoke refresh-external-indexes-cron --no-identity
   # → confirm last run, then disable in netlify.toml + redeploy v1
   ```

2. **Point DNS at v2.** Update the A/CNAME record for the production
   domain to v2's Railway URL. TTL on the record should already be ≤
   60s in advance of cutover.

3. **Watch.** First 30 min:
   - Railway → web service → metrics: response time + error rate flat.
   - Railway → Postgres metrics: connections within `max=20×replicas`.
   - Alchemy dashboard: CU/min flat (worker dominates; web should be
     bounded by `lib/onchain.ts` calls × visit count).
   - Logs: no recurring 5xx on web; worker tasks continue ticking.

4. **First 24h:** spot-check a handful of known-artist pages, a few
   token pages, the catalog flow, the migrate flow.

## Rollback (if needed within 7 days)

DNS cut back to v1. v1's Postgres still has the lazy_* tables intact
(v2's writes go to a separate Postgres in a separate Railway project,
so there's no data corruption to undo). The v1 Netlify scheduled
function re-enables on its next scheduled fire.

## Post-cutover cleanup (after 7 stable days)

- [ ] Delete the v1 Netlify site.
- [ ] Delete the v1 Railway services (Ponder, metadata-warmer, the
      old Postgres if it's separate from v2's).
- [ ] Archive the v1 repo (`ripe0x/pin` → mark archived on GitHub).
- [ ] Update README on the new repo to drop the "rebuild in progress"
      framing.

## Cost-invariant check (run weekly post-launch)

```sql
SELECT task,
       sum(rpc_calls)   AS rpc_calls,
       sum(rows_written) AS rows_written,
       count(*) FILTER (WHERE NOT ok) AS errors
FROM worker_iterations
WHERE started_at > NOW() - INTERVAL '7 days'
GROUP BY task
ORDER BY rpc_calls DESC;
```

Expected ceiling: `known_artists count × tasks-per-day × scans-per-task
× ~2 RPC calls per scan` ≈ low single-digit thousands per day. If you
see a task at 10× expected, a cursor regression or unguarded fallback
slipped in.
