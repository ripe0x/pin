import "server-only"
import type { Address } from "viem"
import { sql } from "./db"

/**
 * Server read for the Phase 1 mint-funded permanence surface
 * (docs/editions-permanence-funding.md). Returns the recorded permanence slice
 * for an edition, or null. Reads ONLY cached Postgres state (written by
 * `/api/editions/permanence`), never the chain — the edition page corroborates
 * it for free against the edition's already-read on-chain `payoutAddress`.
 */
export type PermanenceConfig = {
  split: Address
  vault: Address
  bps: number
}

export async function getPermanenceConfig(edition: string): Promise<PermanenceConfig | null> {
  if (!sql) return null
  const rows = (await sql<Array<{ split: string; vault: string; permanence_bps: number }>>`
    SELECT split, vault, permanence_bps
      FROM editions_permanence
     WHERE edition = ${edition.toLowerCase()}
     LIMIT 1
  `) as Array<{ split: string; vault: string; permanence_bps: number }>
  const row = rows[0]
  if (!row) return null
  return {
    split: row.split as Address,
    vault: row.vault as Address,
    bps: Number(row.permanence_bps),
  }
}
