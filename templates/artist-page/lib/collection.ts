/** Server-side, bounded reads for the artist's optional Surface release. */
import "server-only"
import { unstable_cache } from "next/cache"
import { type Address, type Hex } from "viem"
import { fixedPriceMinterAbi, surfaceAbi } from "./abi"
import { getClient } from "./rpc"
import { getConfig } from "./config"
import {
  decodeCollectionConfig,
  type CollectionConfig,
  type CollectionSummary,
  type MinterSaleConfig,
  type RawCollectionConfig,
} from "./surface"

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000"

type SerializedSale = Omit<
  MinterSaleConfig,
  "price" | "mintStart" | "mintEnd" | "maxMints" | "totalMinted" | "walletCap"
> & {
  price: string
  mintStart: string
  mintEnd: string
  maxMints: string
  totalMinted: string
  walletCap: string
}

type SerializedCollectionSummary = {
  address: Address
  name: string
  symbol: string
  cfg: Omit<CollectionConfig, "supplyCap"> & { supplyCap: string }
  idMode: number
  primaryMinter: Address | null
  sale: SerializedSale | null
  minted: string
}

async function readSale(minter: Address): Promise<MinterSaleConfig | null> {
  const client = getClient()
  const base = { address: minter, abi: fixedPriceMinterAbi } as const
  try {
    const [price, priceStrategy, mintStart, mintEnd, maxMints, totalMinted, allowlistRoot, walletCap, referralShareBps] =
      await client.multicall({
        allowFailure: false,
        contracts: [
          { ...base, functionName: "price" },
          { ...base, functionName: "priceStrategy" },
          { ...base, functionName: "mintStart" },
          { ...base, functionName: "mintEnd" },
          { ...base, functionName: "maxMints" },
          { ...base, functionName: "totalMinted" },
          { ...base, functionName: "allowlistRoot" },
          { ...base, functionName: "walletCap" },
          { ...base, functionName: "referralShareBps" },
        ],
      })
    return {
      minter,
      price: price as bigint,
      priceStrategy: priceStrategy as Address,
      mintStart: mintStart as bigint,
      mintEnd: mintEnd as bigint,
      maxMints: maxMints as bigint,
      totalMinted: totalMinted as bigint,
      allowlistRoot: allowlistRoot as Hex,
      walletCap: walletCap as bigint,
      referralShareBps: Number(referralShareBps),
    }
  } catch {
    return null
  }
}

const _getCollectionCached = unstable_cache(
  async (address: Address): Promise<SerializedCollectionSummary | null> => {
    const client = getClient()
    const base = { address, abi: surfaceAbi } as const
    try {
      const [name, symbol, idMode, primaryMinterRaw, cfgRes] = await client.multicall({
        allowFailure: false,
        contracts: [
          { ...base, functionName: "name" },
          { ...base, functionName: "symbol" },
          { ...base, functionName: "idMode" },
          { ...base, functionName: "primaryMinter" },
          { ...base, functionName: "config" },
        ],
      })
      const [cfgRaw, minted] = cfgRes as readonly [RawCollectionConfig, bigint]
      const cfg = decodeCollectionConfig(cfgRaw)
      const rawMinter = primaryMinterRaw as Address
      const primaryMinter = rawMinter.toLowerCase() === ZERO_ADDRESS ? null : rawMinter
      const sale = primaryMinter ? await readSale(primaryMinter) : null
      return {
        address,
        name: name as string,
        symbol: symbol as string,
        cfg: { ...cfg, supplyCap: cfg.supplyCap.toString() },
        idMode: Number(idMode),
        primaryMinter,
        sale: sale
          ? {
              ...sale,
              price: sale.price.toString(),
              mintStart: sale.mintStart.toString(),
              mintEnd: sale.mintEnd.toString(),
              maxMints: sale.maxMints.toString(),
              totalMinted: sale.totalMinted.toString(),
              walletCap: sale.walletCap.toString(),
            }
          : null,
        minted: (minted as bigint).toString(),
      }
    } catch {
      return null
    }
  },
  ["surface-release-summary-v2"],
  { revalidate: 20, tags: ["collection"] },
)

export async function getCollection(): Promise<CollectionSummary | null> {
  const { collectionAddress } = getConfig()
  if (!collectionAddress) return null
  const raw = await _getCollectionCached(collectionAddress)
  if (!raw) return null
  return {
    ...raw,
    cfg: { ...raw.cfg, supplyCap: BigInt(raw.cfg.supplyCap) },
    idMode: raw.idMode as CollectionSummary["idMode"],
    sale: raw.sale
      ? {
          ...raw.sale,
          price: BigInt(raw.sale.price),
          mintStart: BigInt(raw.sale.mintStart),
          mintEnd: BigInt(raw.sale.mintEnd),
          maxMints: BigInt(raw.sale.maxMints),
          totalMinted: BigInt(raw.sale.totalMinted),
          walletCap: BigInt(raw.sale.walletCap),
        }
      : null,
    minted: BigInt(raw.minted),
  }
}

const _getCurrentPriceCached = unstable_cache(
  async (minter: Address, recipient: Address, qty: string): Promise<string | null> => {
    try {
      const value = await getClient().readContract({
        address: minter,
        abi: fixedPriceMinterAbi,
        functionName: "priceOf",
        args: [recipient, BigInt(qty)],
      })
      return (value as bigint).toString()
    } catch {
      return null
    }
  },
  ["surface-release-price-v2"],
  { revalidate: 5, tags: ["collection"] },
)

export async function getCurrentPrice(
  minter: Address,
  recipient: Address,
  qty = 1n,
): Promise<bigint | null> {
  const raw = await _getCurrentPriceCached(minter, recipient, qty.toString())
  return raw === null ? null : BigInt(raw)
}
