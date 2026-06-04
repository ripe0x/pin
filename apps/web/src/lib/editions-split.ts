/**
 * PND Editions — payout split math (pure, dependency-light).
 *
 * Extracted from pnd-editions.ts so it can be unit-tested under Node's
 * type-stripping test runner (`node --experimental-strip-types --test`), which
 * cannot load pnd-editions.ts because that module declares `enum`s (non-erasable
 * TypeScript). This file is enum-free and imports only viem, so it loads.
 *
 * pnd-editions.ts re-exports everything here, so existing import sites are
 * unchanged.
 *
 * 0xSplits invariants these helpers must always satisfy:
 *   - accounts sorted ascending (by lowercased address)
 *   - allocations on the 1e6 scale (1% = 10_000), summing to EXACTLY 1_000_000
 */
import { type Address, isAddress } from "viem"

/** A collaborator row: an address and an integer percent (1-100). */
export type Collaborator = { address: Address; percent: number }

/**
 * Build sorted 0xSplits `createSplit` args from collaborator rows. 0xSplits
 * requires accounts sorted ascending and allocations on the 1e6 scale (1% =
 * 10_000). Integer percents summing to 100 therefore sum to exactly 1_000_000.
 */
export function buildSplitArgs(rows: Collaborator[]): {
  accounts: Address[]
  allocations: number[]
} {
  const sorted = [...rows].sort((a, b) =>
    a.address.toLowerCase() < b.address.toLowerCase() ? -1 : 1,
  )
  return {
    accounts: sorted.map((r) => r.address),
    allocations: sorted.map((r) => r.percent * 10_000),
  }
}

/** Validate collaborator rows for a 0xSplits split (>=2 unique, percents = 100). */
export function validateCollaborators(rows: { address: string; percent: string }[]): {
  ok: boolean
  error: string | null
  parsed: Collaborator[]
} {
  const filled = rows.filter((r) => r.address.trim() !== "" || r.percent.trim() !== "")
  if (filled.length < 2) return { ok: false, error: "Add at least two collaborators", parsed: [] }
  const parsed: Collaborator[] = []
  const seen = new Set<string>()
  for (const r of filled) {
    if (!isAddress(r.address)) return { ok: false, error: "Invalid collaborator address", parsed: [] }
    const lower = r.address.toLowerCase()
    if (seen.has(lower)) return { ok: false, error: "Duplicate collaborator address", parsed: [] }
    seen.add(lower)
    const pct = Number(r.percent)
    if (!Number.isInteger(pct) || pct < 1 || pct > 100)
      return { ok: false, error: "Each share must be a whole number, 1-100", parsed: [] }
    parsed.push({ address: r.address as Address, percent: pct })
  }
  const sum = parsed.reduce((acc, r) => acc + r.percent, 0)
  if (sum !== 100) return { ok: false, error: `Shares must total 100% (now ${sum}%)`, parsed: [] }
  return { ok: true, error: null, parsed }
}

/**
 * A permanence-funding slice: an artist-owned vault address plus a whole-percent
 * share (1-99) of every mint that routes to it. Phase 1 (Option A) of the
 * mint-funded permanence design (docs/editions-permanence-funding.md): the vault
 * is just one more recipient in the artist's payout split, so a slice of every
 * mint accrues toward keeping the work's media alive — with NO change to the
 * audited core contract. The vault is the artist's (sovereign); PND never holds
 * it. Later phases swap the EOA vault for a PNDPermanenceVault contract and add
 * the Irys/Arweave + Pinata-x402 spend rails.
 */
export type PermanenceSlice = { vault: Address; percent: number }

/**
 * Build sorted 0xSplits `createSplit` args from base payout rows plus an
 * optional permanence slice. The vault becomes one more recipient: it takes
 * `percent`% of every distribution and the base rows share the remaining
 * (100 - percent)% in their existing proportions. Allocations are on 0xSplits'
 * 1e6 scale (1% = 10_000) and are corrected so they sum to exactly 1_000_000
 * (0xSplits rejects any other total). Accounts are returned sorted ascending.
 *
 * Note (Option A's known compromise, per the design doc §2.2): the slice is
 * carved from the artist+collaborator pool, so it proportionally dilutes the
 * base rows. The create UI states this rather than hiding it. The first-class
 * `permanenceBps` `_settle` leg (Option B) that takes the slice BEFORE the
 * artist split is a later, core-contract phase.
 */
export function buildSplitArgsWithPermanence(
  baseRows: Collaborator[],
  permanence: PermanenceSlice | null,
): { accounts: Address[]; allocations: number[] } {
  if (!permanence) return buildSplitArgs(baseRows)

  const SCALE = 1_000_000
  const vaultAlloc = permanence.percent * 10_000
  const remaining = SCALE - vaultAlloc
  const baseTotal = baseRows.reduce((acc, r) => acc + r.percent, 0)

  // Distribute `remaining` across base rows proportional to their percent.
  const rows = baseRows.map((r) => ({
    address: r.address,
    alloc: baseTotal === 0 ? 0 : Math.floor((remaining * r.percent) / baseTotal),
  }))
  // Push any floor() rounding drift onto the largest base row so the
  // allocations sum to exactly SCALE (0xSplits requires an exact total).
  const distributed = rows.reduce((acc, r) => acc + r.alloc, 0)
  const drift = remaining - distributed
  if (drift !== 0 && rows.length > 0) {
    let maxI = 0
    for (let i = 1; i < rows.length; i++) if (rows[i].alloc > rows[maxI].alloc) maxI = i
    rows[maxI].alloc += drift
  }
  rows.push({ address: permanence.vault, alloc: vaultAlloc })

  const sorted = [...rows].sort((a, b) =>
    a.address.toLowerCase() < b.address.toLowerCase() ? -1 : 1,
  )
  return {
    accounts: sorted.map((r) => r.address),
    allocations: sorted.map((r) => r.alloc),
  }
}

/**
 * Validate a permanence slice for the create flow. The vault must be a valid
 * address distinct from every base payout/collaborator address (0xSplits needs
 * unique accounts), and the share must be a whole 1-99 (it must leave room for
 * the artist/collaborators).
 */
export function validatePermanence(
  vault: string,
  percent: string,
  baseAddresses: string[],
): { ok: boolean; error: string | null; parsed: PermanenceSlice | null } {
  if (!isAddress(vault)) return { ok: false, error: "Invalid vault address", parsed: null }
  const pct = Number(percent)
  if (!Number.isInteger(pct) || pct < 1 || pct > 99)
    return { ok: false, error: "Permanence share must be a whole number, 1-99", parsed: null }
  const lower = vault.toLowerCase()
  if (baseAddresses.some((a) => a.toLowerCase() === lower))
    return {
      ok: false,
      error: "Vault must differ from the payout and collaborator addresses",
      parsed: null,
    }
  return { ok: true, error: null, parsed: { vault: vault as Address, percent: pct } }
}
