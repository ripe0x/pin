-- Many-to-many creator evidence. `artist_tokens` remains the compatibility
-- token inventory, while this table allows collaborations and multiple
-- independently observed creator claims without overwriting one another.
-- Catalog declarations stay separate because a declaration is context, not
-- automatically verified mint attribution.

CREATE TABLE IF NOT EXISTS work_attributions (
  artist          TEXT NOT NULL,
  contract        TEXT NOT NULL,
  token_id        TEXT NOT NULL,
  source          TEXT NOT NULL,
  platform        TEXT NOT NULL,
  mint_block      BIGINT NOT NULL,
  mint_log_index  BIGINT NOT NULL,
  evidence_status TEXT NOT NULL DEFAULT 'indexed-mint'
                  CHECK (evidence_status IN ('indexed-mint', 'contract-authority')),
  observed_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (artist, contract, token_id, source),
  CHECK (artist ~ '^0x[0-9a-f]{40}$')
);

CREATE INDEX IF NOT EXISTS work_attributions_artist_keyset_idx
  ON work_attributions
    (artist, mint_block DESC, mint_log_index DESC, contract DESC, token_id DESC);

CREATE INDEX IF NOT EXISTS work_attributions_token_idx
  ON work_attributions (contract, token_id, artist);

INSERT INTO work_attributions (
  artist, contract, token_id, source, platform, mint_block, mint_log_index
)
SELECT lower(artist), lower(contract), token_id,
       'worker-' || platform, platform, mint_block, mint_log_index
FROM artist_tokens
ON CONFLICT DO NOTHING;

CREATE OR REPLACE FUNCTION mirror_artist_token_attribution()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  INSERT INTO work_attributions (
    artist, contract, token_id, source, platform, mint_block, mint_log_index
  ) VALUES (
    lower(NEW.artist), lower(NEW.contract), NEW.token_id,
    'worker-' || NEW.platform, NEW.platform, NEW.mint_block, NEW.mint_log_index
  )
  ON CONFLICT (artist, contract, token_id, source) DO UPDATE SET
    platform = EXCLUDED.platform,
    mint_block = LEAST(work_attributions.mint_block, EXCLUDED.mint_block),
    mint_log_index = CASE
      WHEN EXCLUDED.mint_block < work_attributions.mint_block
        THEN EXCLUDED.mint_log_index
      ELSE LEAST(work_attributions.mint_log_index, EXCLUDED.mint_log_index)
    END,
    observed_at = NOW();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS artist_tokens_to_attribution ON artist_tokens;
CREATE TRIGGER artist_tokens_to_attribution
AFTER INSERT OR UPDATE OF artist, platform, mint_block, mint_log_index
ON artist_tokens
FOR EACH ROW
EXECUTE FUNCTION mirror_artist_token_attribution();

-- Replace migration 033's single-artist compatibility view with the
-- many-to-many evidence model. Multiple sources for the same artist/work are
-- ranked to one profile row; different artists remain distinct.
CREATE OR REPLACE VIEW profile_created_works AS
WITH ranked AS (
  SELECT a.*,
         ROW_NUMBER() OVER (
           PARTITION BY a.artist, a.contract, a.token_id
           ORDER BY
             CASE WHEN a.evidence_status = 'indexed-mint' THEN 0 ELSE 1 END,
             a.mint_block,
             a.mint_log_index,
             a.source
         ) AS attribution_rank
  FROM work_attributions a
)
SELECT
  a.artist,
  a.contract,
  a.token_id,
  a.platform,
  a.mint_block,
  a.mint_log_index,
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
    WHEN lower(o.owner) = a.artist
      THEN 'creator-held'
    WHEN o.owner IS NOT NULL
      THEN 'transferred'
    ELSE 'created'
  END AS lifecycle_evidence
FROM ranked a
LEFT JOIN artist_tokens at
  ON lower(at.contract) = a.contract AND at.token_id = a.token_id
LEFT JOIN token_ownership o
  ON o.contract = a.contract AND o.token_id = a.token_id
WHERE a.attribution_rank = 1;

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
  a.artist AS attributed_creator,
  a.platform
FROM token_holdings_current h
LEFT JOIN LATERAL (
  SELECT artist, platform
  FROM work_attributions a
  WHERE a.contract = lower(h.contract) AND a.token_id = h.token_id
  ORDER BY
    CASE WHEN a.evidence_status = 'indexed-mint' THEN 0 ELSE 1 END,
    a.artist,
    a.source
  LIMIT 1
) a ON TRUE;

COMMENT ON TABLE work_attributions IS
  'Many-to-many indexed creator evidence; Catalog declarations are intentionally separate.';
