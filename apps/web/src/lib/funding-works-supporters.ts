/**
 * Lifetime supporter list for the FundingWorksRipe campaign.
 *
 * Powers the global "Thank you. Supported by:" footer at the bottom of
 * every page. Reads `TokenMinted` event logs once per 24h and resolves
 * each unique minter to an ENS name (or null) using the same off-RPC
 * EFP-first identity helper the rest of the site uses, so the daily
 * cold path is one Alchemy `getLogs` plus near-zero ENS work for
 * already-resolved addresses.
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
import { getArtistIdentity } from "./artist-queries"

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
}

const client = createPublicClient({
  chain: mainnet,
  transport: loggingHttpTransport(getAlchemyMainnetUrl(), "fwr-supporters"),
})

const fetchSupporters = unstable_cache(
  async (): Promise<Supporter[]> => {
    return pgCache("fwr-supporters:v1", 60 * 60 * 24, async () => {
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

        const seen = new Set<string>()
        const ordered: `0x${string}`[] = []
        for (const log of sorted) {
          const minter = log.args.minter
          if (!minter) continue
          const lower = minter.toLowerCase() as `0x${string}`
          if (seen.has(lower)) continue
          seen.add(lower)
          ordered.push(lower)
        }

        // Identity resolution reuses the EFP-first / RPC-fallback helper
        // that powers artist pages and activity feeds. Both name and
        // avatar are cached 24h per address; we ignore the avatar but
        // get name resolution effectively for free for any address that
        // has been seen elsewhere on the site in the last day.
        const identities = await Promise.all(
          ordered.map((addr) =>
            getArtistIdentity(addr).catch(() => null),
          ),
        )

        return ordered.map((addr, i) => ({
          address: addr,
          ensName: identities[i]?.ensName ?? null,
        }))
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error("[fwr-supporters] fetch failed", err)
        return []
      }
    })
  },
  ["fwr-supporters-v1"],
  { revalidate: 60 * 60 * 24, tags: ["fwr-supporters"] },
)

export async function getFundingWorksSupporters(): Promise<Supporter[]> {
  return fetchSupporters()
}
