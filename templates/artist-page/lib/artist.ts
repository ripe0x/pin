/**
 * Server-side helpers for the artist's identity. The display name resolves
 * in this order:
 *
 *   1. `NEXT_PUBLIC_ARTIST_NAME` env var (if the artist set one)
 *   2. ENS reverse-lookup of `NEXT_PUBLIC_ARTIST_ADDRESS`
 *   3. Truncated address (`0x1234…abcd`)
 *
 * Cached at the ENS layer (6 hours per address).
 */
import "server-only"
import { getConfig } from "./config"
import { getEnsName } from "./ens"
import { formatAddress } from "./format"

export async function getArtistDisplayName(): Promise<string> {
  const cfg = getConfig()
  if (cfg.artistName) return cfg.artistName
  const ens = await getEnsName(cfg.artistAddress)
  if (ens) return ens
  return formatAddress(cfg.artistAddress)
}
