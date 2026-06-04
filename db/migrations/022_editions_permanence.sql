-- editions_permanence: per-edition record of the Phase 1 mint-funded
-- permanence slice (docs/editions-permanence-funding.md). When an artist
-- enables "Fund this work's permanence" in the create flow, a slice of every
-- mint routes to an artist-owned vault by making the vault one more recipient
-- in the edition's 0xSplits payout split. There is no on-chain marker that
-- distinguishes the "permanence vault" recipient from a collaborator recipient,
-- so this table records the off-chain label (which recipient is the vault, and
-- its bps) that the edition page surfaces.
--
-- Written by `/api/editions/permanence`, which verifies an EOA signature (proves
-- the caller controls `artist`) exactly like the /preserve writeback. The split
-- address is stored so the edition page can CORROBORATE the record for free:
-- it only surfaces the permanence fact when `split` equals the edition's actual
-- on-chain `payoutAddress` (already read at render). Anyone can further verify
-- the vault is a real recipient at the claimed share on the 0xSplits split
-- on-chain.
--
-- Trust model: self-declaration, corroborated on-chain. The vault is the
-- artist's own address; PND never holds it. This is a funding pot, not
-- permanence on its own — later phases spend it on Irys/Arweave + Pinata rails.

CREATE TABLE IF NOT EXISTS editions_permanence (
  edition         TEXT NOT NULL,        -- the PNDEditions contract (lowercase)
  split           TEXT NOT NULL,        -- the 0xSplits payout split (lowercase)
  vault           TEXT NOT NULL,        -- the artist-owned permanence vault (lowercase)
  permanence_bps  INTEGER NOT NULL,     -- vault's share of each mint, in bps (1..9999)
  artist          TEXT NOT NULL,        -- the signer that attested this (lowercase)
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (edition)
);

CREATE INDEX IF NOT EXISTS editions_permanence_vault_idx ON editions_permanence (vault);
