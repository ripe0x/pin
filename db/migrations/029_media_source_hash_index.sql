-- Inline `data:` sources can be hundreds of KB, over the 8 KB btree row
-- limit, so inserting one into token_media_delivery failed and stalled the
-- whole derive queue. Source lookups are equality-only (reuse of an exact
-- source's derivative), which a hash index serves with no size limit.

DROP INDEX IF EXISTS token_media_delivery_source_idx;

CREATE INDEX IF NOT EXISTS token_media_delivery_source_url_hash_idx
  ON token_media_delivery USING hash (source_url);
