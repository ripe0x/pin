/**
 * Server-side reads for the artist's optional SovereignCollection.
 *
 * Mirrors `lib/auctions.ts`'s pattern: cheap, cached, server-rendered
 * `initial` state that the client components then keep live via
 * `useReadContract` polling (see components/CollectionMintCard.tsx). Only
 * used when `NEXT_PUBLIC_COLLECTION_ADDRESS` is set — see lib/config.ts.
 *
 * Enums/types/decoders live in `./sovereign-collection` (no server-only
 * import there) so client components can use them directly without pulling
 * this module's `server-only` marker along for the ride.
 *
 * Every `unstable_cache`-wrapped function here returns bigints as decimal
 * strings, never raw `bigint` — `unstable_cache` JSON-serializes its return
 * value for the disk cache, and `JSON.stringify` throws on a bigint (same
 * pitfall documented in lib/token.ts). Bigints are reconstructed only in the
 * public wrapper, at the boundary where callers actually need them.
 */
import "server-only"
import { unstable_cache } from "next/cache"
import { type Address } from "viem"
import { sovereignCollectionAbi } from "./abi"
import { getClient } from "./rpc"
import { getConfig } from "./config"
import {
  decodeCollectionConfig,
  type CollectionConfig,
  type CollectionSummary,
  type RawCollectionConfig,
} from "./sovereign-collection"

type SerializedCollectionSummary = {
  address: Address
  name: string
  symbol: string
  cfg: Omit<CollectionConfig, "price" | "supplyCap" | "mintStart" | "mintEnd"> & {
    price: string
    supplyCap: string
    mintStart: string
    mintEnd: string
  }
  status: number
  minted: string
}

const _getCollectionCached = unstable_cache(
  async (address: Address): Promise<SerializedCollectionSummary | null> => {
    const client = getClient()
    const base = { address, abi: sovereignCollectionAbi } as const
    try {
      const [name, symbol, cfgRes] = await client.multicall({
        allowFailure: false,
        contracts: [
          { ...base, functionName: "name" },
          { ...base, functionName: "symbol" },
          { ...base, functionName: "config" },
        ],
      })
      const [cfgRaw, status, minted] = cfgRes as readonly [
        RawCollectionConfig,
        number,
        bigint,
      ]
      const cfg = decodeCollectionConfig(cfgRaw)
      return {
        address,
        name: name as string,
        symbol: symbol as string,
        cfg: {
          ...cfg,
          price: cfg.price.toString(),
          supplyCap: cfg.supplyCap.toString(),
          mintStart: cfg.mintStart.toString(),
          mintEnd: cfg.mintEnd.toString(),
        },
        status: Number(status),
        minted: minted.toString(),
      }
    } catch {
      return null
    }
  },
  ["collection-summary-v1"],
  { revalidate: 20, tags: ["collection"] },
)

/** The configured collection's current config/status/minted, or null if unset/unreadable. */
export async function getCollection(): Promise<CollectionSummary | null> {
  const { collectionAddress } = getConfig()
  if (!collectionAddress) return null
  const raw = await _getCollectionCached(collectionAddress)
  if (!raw) return null
  return {
    address: raw.address,
    name: raw.name,
    symbol: raw.symbol,
    cfg: {
      ...raw.cfg,
      price: BigInt(raw.cfg.price),
      supplyCap: BigInt(raw.cfg.supplyCap),
      mintStart: BigInt(raw.cfg.mintStart),
      mintEnd: BigInt(raw.cfg.mintEnd),
    },
    status: raw.status,
    minted: BigInt(raw.minted),
  }
}

const _getCurrentPriceCached = unstable_cache(
  async (address: Address, minter: Address, qty: string): Promise<string | null> => {
    const client = getClient()
    try {
      const price = await client.readContract({
        address,
        abi: sovereignCollectionAbi,
        functionName: "currentPrice",
        args: [minter, BigInt(qty), "0x"],
      })
      return (price as bigint).toString()
    } catch {
      return null
    }
  },
  ["collection-current-price-v1"],
  // Short TTL: a price-strategy collection's quote can change every block
  // (see apps/web/src/lib/collection-onchain.ts's getCurrentPrice, which
  // this mirrors). Stale-but-cached is still far better than an RPC call
  // per page render.
  { revalidate: 5, tags: ["collection"] },
)

/**
 * Price for minting `qty` tokens, quoted for `minter`. Zero address is a
 * fine minter to quote for when no wallet is connected yet — most price
 * strategies don't discriminate by address, and this is only ever used for
 * the pre-connect display estimate; the live client-side read (see
 * CollectionMintCard) is the source of truth once a wallet is connected.
 */
export async function getCurrentPrice(qty = 1n): Promise<bigint | null> {
  const { collectionAddress } = getConfig()
  if (!collectionAddress) return null
  const ZERO = "0x0000000000000000000000000000000000000000" as Address
  const raw = await _getCurrentPriceCached(collectionAddress, ZERO, qty.toString())
  return raw === null ? null : BigInt(raw)
}
