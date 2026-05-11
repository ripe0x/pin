/**
 * Lifetime supporter list for the FundingWorksRipe campaign.
 *
 * The campaign is closed — no new mints expected. The resolved list is
 * frozen in `data/fwr-supporters.json`. This file is the runtime read
 * path the footer uses; it does zero RPC, no DB, no cron.
 *
 * To regenerate the snapshot (e.g. a late ENS reverse record gets set
 * after this snapshot was taken), run:
 *
 *   npm run snapshot:fwr-supporters
 *
 * That script re-scans `TokenMinted` from the FWR contract, re-resolves
 * ENS for each minter, and overwrites the JSON file. The change ships
 * via a regular commit + deploy.
 */
import snapshot from "@/data/fwr-supporters.json"

export type Supporter = {
  address: `0x${string}`
  ensName: string | null
  mintCount: number
}

export type SupportersPayload = {
  supporters: Supporter[]
  totalSupporters: number
  totalMints: number
}

const SUPPORTERS = snapshot.supporters as unknown as Supporter[]
const TOTAL_MINTS = SUPPORTERS.reduce((s, x) => s + x.mintCount, 0)

const PAYLOAD: SupportersPayload = {
  supporters: SUPPORTERS,
  totalSupporters: SUPPORTERS.length,
  totalMints: TOTAL_MINTS,
}

export async function getFundingWorksSupporters(): Promise<SupportersPayload> {
  return PAYLOAD
}
