/**
 * Lifetime supporter list for the FundingWorksRipe campaign.
 *
 * Powers the global "Thank you. Supported by:" footer at the bottom of
 * every page. Reads `TokenMinted` event logs once per 24h and resolves
 * each unique minter to an ENS name (or null) using a hybrid resolver
 * (EFP-first, viem fallback) that gets the best of both worlds:
 *
 *   - EFP serves names off-RPC for the addresses it knows about
 *     (~40% coverage in practice on this list).
 *   - When EFP returns `{name: null}` (legitimate "no record") we still
 *     try direct viem `getEnsName`, because EFP's reverse-resolution
 *     index is incomplete and many supporter addresses have ENS set
 *     on-chain that EFP doesn't surface.
 *
 * The site-wide `getArtistIdentity` helper trusts EFP's null answer
 * without falling back — a deliberate perf tradeoff for hot paths like
 * artist pages and the activity feed. For a once-per-24h footer fetch,
 * we'd rather pay the extra RPC and show every name we can.
 *
 * Two-layer cache (L1 `unstable_cache` + L2 `pgCache`) means every
 * Netlify sandbox shares the same warm result — page renders after the
 * first miss are pure Postgres reads, no RPC.
 *
 * Failure path returns an empty list so a network blip never breaks
 * the layout (the SupportersList component renders nothing when the
 * list is empty).
 */
import { unstable_cache } from "next/cache"
import { createPublicClient, parseAbiItem } from "viem"
import { mainnet } from "viem/chains"
import { pgCache } from "./pg-cache"
import { getAlchemyMainnetUrl } from "./alchemy-rpc"
import { loggingHttpTransport } from "./rpc-log"
import {
  resolveEfpEnsCached,
  resolveEnsNameCached,
} from "./artist-queries"

// FundingWorksRipe campaign on mainnet — the contract that minted the
// supporter NFTs that funded this work. Both values are overridable via
// env so tests / preview deploys can point at a different deployment
// without code changes; defaults are the production mainnet values.
const FWR_CONTRACT = (process.env.NEXT_PUBLIC_FWR_CONTRACT_ADDRESS ??
  "0xA78846573c4eDA142DFe10335F560a5cF3486894") as `0x${string}`
const FWR_DEPLOY_BLOCK = BigInt(
  process.env.NEXT_PUBLIC_FWR_DEPLOY_BLOCK ?? "25009880",
)

const TOKEN_MINTED_EVENT = parseAbiItem(
  "event TokenMinted(address indexed minter, uint256 indexed tokenId, bytes32 mintHash)",
)

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

const client = createPublicClient({
  chain: mainnet,
  transport: loggingHttpTransport(getAlchemyMainnetUrl(), "fwr-supporters"),
})

/**
 * Hybrid ENS resolver tuned for the supporter list (see file header).
 * Tries the off-RPC EFP record first; if EFP returns no record OR a
 * record with `{name: null}`, falls back to direct viem `getEnsName`.
 * Returns null for addresses that have no reverse ENS record set.
 */
async function resolveSupporterEnsName(
  address: `0x${string}`,
): Promise<string | null> {
  const lower = address.toLowerCase()
  try {
    const efp = await resolveEfpEnsCached(lower)
    if (efp?.name) return efp.name
    return await resolveEnsNameCached(lower)
  } catch {
    return null
  }
}

const EMPTY_PAYLOAD: SupportersPayload = {
  supporters: [],
  totalSupporters: 0,
  totalMints: 0,
}

const fetchSupporters = unstable_cache(
  async (): Promise<SupportersPayload> => {
    return pgCache("fwr-supporters:v3", 60 * 60 * 24, async () => {
      try {
        const logs = await client.getLogs({
          address: FWR_CONTRACT,
          event: TOKEN_MINTED_EVENT,
          fromBlock: FWR_DEPLOY_BLOCK,
          toBlock: "latest",
        })

        // viem returns logs in block/log order, but be defensive: the
        // first log for each unique minter wins so the rendered list is
        // ordered by "first time they supported".
        const sorted = [...logs].sort((a, b) => {
          if (a.blockNumber !== b.blockNumber) {
            return a.blockNumber < b.blockNumber ? -1 : 1
          }
          return (a.logIndex ?? 0) - (b.logIndex ?? 0)
        })

        const counts = new Map<string, number>()
        const ordered: `0x${string}`[] = []
        for (const log of sorted) {
          const minter = log.args.minter
          if (!minter) continue
          const lower = minter.toLowerCase() as `0x${string}`
          if (!counts.has(lower)) ordered.push(lower)
          counts.set(lower, (counts.get(lower) ?? 0) + 1)
        }

        // Hybrid name resolution: EFP first (off-RPC, fast), then a
        // direct viem ENS lookup whenever EFP returns null or
        // `{name: null}`. Both layers are themselves 24h-cached per
        // address, so the marginal cost of falling back is one
        // `getEnsName` RPC per "EFP doesn't know" minter per 24h.
        const ensNames = await Promise.all(
          ordered.map((addr) => resolveSupporterEnsName(addr)),
        )

        const supporters: Supporter[] = ordered.map((addr, i) => ({
          address: addr,
          ensName: ensNames[i],
          mintCount: counts.get(addr) ?? 1,
        }))

        const totalMints = supporters.reduce((s, x) => s + x.mintCount, 0)

        return {
          supporters,
          totalSupporters: supporters.length,
          totalMints,
        }
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error("[fwr-supporters] fetch failed", err)
        return EMPTY_PAYLOAD
      }
    })
  },
  ["fwr-supporters-v3"],
  { revalidate: 60 * 60 * 24, tags: ["fwr-supporters"] },
)

export async function getFundingWorksSupporters(): Promise<SupportersPayload> {
  return fetchSupporters()
}
