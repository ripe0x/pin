import "server-only"
import {
  createPublicClient,
  type Address,
  type PublicClient,
} from "viem"
import { mainnet } from "viem/chains"
import { catalogAbi } from "@pin/abi"
import {
  ARTIST_RECORD_REGISTRY,
  MAINNET_CHAIN_ID,
  getAddressOrNull,
} from "@pin/addresses"
import { loggingFallbackTransport } from "./rpc-log"

/**
 * Read layer for CatalogRegistry. The contract's read functions
 * are cheap point lookups (one storage slot for booleans, small arrays
 * for the per-artist lists), so v1 reads directly via RPC rather than
 * indexing events into Ponder. If usage grows or cross-artist queries
 * become important ("all artists who declared contract X"), a Ponder
 * subgraph can be layered on later — the read API surface here stays
 * the same.
 *
 * No write functions here. Writes happen client-side via wagmi /
 * walletConnect from the /record UI; the server never holds keys.
 */

const REGISTRY = getAddressOrNull(ARTIST_RECORD_REGISTRY, MAINNET_CHAIN_ID)

export type Catalog = {
  /** The address this record belongs to. */
  artist: Address
  /** Contract addresses the artist has declared. */
  contracts: Address[]
  /** Single-token pointers. */
  tokens: Array<{ contractAddress: Address; tokenId: string }>
  /** Token-range pointers. Bounds are inclusive. */
  tokenRanges: Array<{
    contractAddress: Address
    startTokenId: string
    endTokenId: string
  }>
}

function getClient(): PublicClient {
  return createPublicClient({
    chain: mainnet,
    transport: loggingFallbackTransport("catalog"),
  })
}

/**
 * Read one artist's full record. Issues a single multicall for the
 * three read functions (contracts, tokens, ranges) so the RPC cost is
 * one round-trip regardless of record size.
 *
 * Returns an empty record (no contracts/tokens/ranges) when the
 * registry address isn't configured for the current chain or when the
 * artist hasn't declared anything yet — these states are
 * indistinguishable from the consumer's perspective and both render
 * "no record yet" in the UI.
 */
export async function getCatalog(
  artist: Address,
): Promise<Catalog> {
  if (!REGISTRY) {
    return emptyRecord(artist)
  }
  const client = getClient()
  const calls = [
    {
      address: REGISTRY,
      abi: catalogAbi,
      functionName: "getContracts" as const,
      args: [artist] as const,
    },
    {
      address: REGISTRY,
      abi: catalogAbi,
      functionName: "getTokens" as const,
      args: [artist] as const,
    },
    {
      address: REGISTRY,
      abi: catalogAbi,
      functionName: "getTokenRanges" as const,
      args: [artist] as const,
    },
  ]
  let results
  try {
    results = await client.multicall({
      contracts: calls,
      allowFailure: false,
    })
  } catch (e) {
    // Pre-deploy / wrong-chain / RPC blip: degrade to empty record so
    // callers don't have to wrap each call themselves. The most common
    // cause here is the contract simply not existing at the configured
    // address (multicall returns 0x, decoding fails). Treat as "no
    // record yet."
    if (isContractMissing(e)) return emptyRecord(artist)
    throw e
  }

  const [rawContracts, rawTokens, rawRanges] = results as [
    readonly Address[],
    readonly { contractAddress: Address; tokenId: bigint }[],
    readonly {
      contractAddress: Address
      startTokenId: bigint
      endTokenId: bigint
    }[],
  ]

  return {
    artist,
    contracts: [...rawContracts],
    tokens: rawTokens.map((t) => ({
      contractAddress: t.contractAddress,
      tokenId: t.tokenId.toString(),
    })),
    tokenRanges: rawRanges.map((r) => ({
      contractAddress: r.contractAddress,
      startTokenId: r.startTokenId.toString(),
      endTokenId: r.endTokenId.toString(),
    })),
  }
}

/**
 * Heuristic: was this error caused by the registry contract not
 * existing at its configured address? viem surfaces this as the
 * `getContracts returned no data ("0x")` cause chain when an
 * eth_call to an EOA / non-existent contract is ABI-decoded.
 */
function isContractMissing(err: unknown): boolean {
  if (!(err instanceof Error)) return false
  const msg = err.message || ""
  return (
    msg.includes('returned no data ("0x")') ||
    msg.includes("Cannot decode zero data") ||
    msg.includes("ContractFunctionZeroDataError")
  )
}

/**
 * Check whether `operator` is approved to act on behalf of `artist`.
 */
export async function isApprovedOperator(
  artist: Address,
  operator: Address,
): Promise<boolean> {
  if (!REGISTRY) return false
  const client = getClient()
  return (await client.readContract({
    address: REGISTRY,
    abi: catalogAbi,
    functionName: "isOperator",
    args: [artist, operator],
  })) as boolean
}

function emptyRecord(artist: Address): Catalog {
  return {
    artist,
    contracts: [],
    tokens: [],
    tokenRanges: [],
  }
}

/**
 * Convenience: is this address known to have declared anything? Cheap
 * O(1) check used by the dependency report to decide whether to call
 * the full `getCatalog` or skip it.
 */
export async function hasAnyDeclarations(
  artist: Address,
): Promise<boolean> {
  if (!REGISTRY) return false
  const client = getClient()
  const calls = [
    {
      address: REGISTRY,
      abi: catalogAbi,
      functionName: "getContractCount" as const,
      args: [artist] as const,
    },
    {
      address: REGISTRY,
      abi: catalogAbi,
      functionName: "getTokenCount" as const,
      args: [artist] as const,
    },
    {
      address: REGISTRY,
      abi: catalogAbi,
      functionName: "getTokenRangeCount" as const,
      args: [artist] as const,
    },
  ]
  let results
  try {
    results = (await client.multicall({
      contracts: calls,
      allowFailure: false,
    })) as unknown as [bigint, bigint, bigint]
  } catch (e) {
    if (isContractMissing(e)) return false
    throw e
  }
  const [cc, tc, rc] = results
  return cc > 0n || tc > 0n || rc > 0n
}
