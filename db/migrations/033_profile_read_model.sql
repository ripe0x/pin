-- Profile-specific read model. These views keep creator attribution, current
-- possession, and transfer evidence separate; they deliberately do not infer a
-- sale from a transfer or call a Catalog declaration proof of authorship.

CREATE INDEX IF NOT EXISTS artist_tokens_profile_keyset_idx
  ON artist_tokens (
    artist,
    mint_block DESC,
    mint_log_index DESC,
    contract DESC,
    token_id DESC
  );

CREATE OR REPLACE VIEW profile_created_works AS
SELECT
  lower(at.artist) AS artist,
  lower(at.contract) AS contract,
  at.token_id,
  at.platform,
  at.mint_block,
  at.mint_log_index,
  at.mint_time,
  lower(o.owner) AS current_owner,
  o.source AS ownership_source,
  o.last_block AS ownership_block,
  o.log_index AS ownership_log_index,
  o.observed_at AS ownership_observed_at,
  o.finalized AS ownership_finalized,
  o.coverage_status AS ownership_coverage,
  CASE
    WHEN o.owner = '0x0000000000000000000000000000000000000000'
      THEN 'burned'
    WHEN lower(o.owner) = lower(at.artist)
      THEN 'creator-held'
    WHEN o.owner IS NOT NULL
      THEN 'transferred'
    ELSE 'created'
  END AS lifecycle_evidence
FROM artist_tokens at
LEFT JOIN token_ownership o
  ON o.contract = lower(at.contract)
 AND o.token_id = at.token_id;

CREATE OR REPLACE VIEW profile_collected_works AS
SELECT
  lower(h.holder) AS holder,
  lower(h.contract) AS contract,
  h.token_id,
  h.token_standard,
  h.balance,
  h.source AS ownership_source,
  h.last_block,
  h.log_index,
  h.observed_at,
  h.finalized,
  h.coverage_status,
  lower(at.artist) AS attributed_creator,
  at.platform
FROM token_holdings_current h
LEFT JOIN artist_tokens at
  ON lower(at.contract) = lower(h.contract)
 AND at.token_id = h.token_id;

COMMENT ON VIEW profile_created_works IS
  'Creator-attributed work with current ownership evidence. transferred is not sold.';

COMMENT ON VIEW profile_collected_works IS
  'Current holdings only within PND indexed ownership coverage.';
