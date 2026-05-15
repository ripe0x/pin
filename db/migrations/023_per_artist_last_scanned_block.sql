-- Per-artist `last_scanned_block` columns on the three external-platform
-- status tables. Replaces the wasteful full-history rescan that
-- `refreshArtist` performed on every cron run + every "Refresh my work"
-- button click. Each scan now reads from the recorded block forward.
--
-- Convention:
--   - NULL `last_scanned_block` → never scanned → fall back to the
--     platform's `*_DEPLOY_BLOCK` constant (full first scan).
--   - Set after a successful scan completes; equal to the chain head
--     observed during that scan.
--
-- Mirrors the existing `lazy_sr_seller_listings.last_scanned_block`
-- pattern from migration 020. ALTER … ADD COLUMN IF NOT EXISTS is
-- idempotent for re-runs.

ALTER TABLE lazy_manifold_artist_status
  ADD COLUMN IF NOT EXISTS last_scanned_block BIGINT;
ALTER TABLE lazy_srv2_artist_status
  ADD COLUMN IF NOT EXISTS last_scanned_block BIGINT;
ALTER TABLE lazy_tl_artist_status
  ADD COLUMN IF NOT EXISTS last_scanned_block BIGINT;
