-- Incremental rescan support for the lazy seller-listings tables. Before
-- this column existed, every cache miss re-ran the full log scan from each
-- marketplace's deploy block (FND: ~Dec 2021, SR: ~Apr 2022) to head. For
-- a seller visited regularly, that's ~6 chunks × ~500ms in eth_getLogs
-- *per cache miss*, even though 99.9% of the scanned range produced no
-- new events.
--
-- `last_scanned_block` lets the adapter scan only `(last_scanned + 1, head)`
-- on refresh. New listings get picked up; the multicall step that
-- confirms each candidate is still cancellable also handles cancels /
-- settles / bids that happened in the gap (those drop out at the
-- multicall layer).
--
-- Nullable for backfill compatibility: existing rows are treated as
-- "scanned to an unknown block", so the next refresh does a full re-scan
-- once and then settles into incremental mode. New rows always have a
-- value.

ALTER TABLE lazy_fnd_seller_listings
  ADD COLUMN IF NOT EXISTS last_scanned_block BIGINT;

ALTER TABLE lazy_sr_seller_listings
  ADD COLUMN IF NOT EXISTS last_scanned_block BIGINT;
