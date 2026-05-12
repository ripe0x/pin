import "server-only"
import {
  createPublicClient,
  type Address,
  type PublicClient,
} from "viem"
import { mainnet } from "viem/chains"
import { artistRecordRegistryAbi } from "@pin/abi"
import {
  ARTIST_RECORD_REGISTRY,
  MAINNET_CHAIN_ID,
  getAddressOrNull,
} from "@pin/addresses"
import { getMainnetTransport } from "./alchemy-transport"

/**
 * Read layer for ArtistRecordRegistry. The contract's read functions
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

export type ArtistRecord = {
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
  /** Successor address declared by this artist, or null. */
  successor: Address | null
}

export type ArtistRecordWithChain = ArtistRecord & {
  /** Forward successor chain rooted at the queried address. Always
   * starts with the queried address; subsequent entries are each
   * predecessor's declared successor, walked until either a zero
   * successor is found or the chain hits its max-depth bound. */
  successorChain: Address[]
}

function getClient(): PublicClient {
  return createPublicClient({
    chain: mainnet,
    transport: getMainnetTransport("artist-record"),
  })
}

/**
 * Read one artist's full record. Issues a single multicall for the
 * four read functions (contracts, tokens, ranges, successor) so the
 * RPC cost is one round-trip regardless of record size.
 *
 * Returns an empty record (no contracts/tokens/ranges, successor null)
 * when the registry address isn't configured for the current chain or
 * when the artist hasn't declared anything yet — these states are
 * indistinguishable from the consumer's perspective and both render
 * "no record yet" in the UI.
 */
export async function getArtistRecord(
  artist: Address,
): Promise<ArtistRecord> {
  if (!REGISTRY) {
    return emptyRecord(artist)
  }
  const client = getClient()
  const calls = [
    {
      address: REGISTRY,
      abi: artistRecordRegistryAbi,
      functionName: "getContracts" as const,
      args: [artist] as const,
    },
    {
      address: REGISTRY,
      abi: artistRecordRegistryAbi,
      functionName: "getTokens" as const,
      args: [artist] as const,
    },
    {
      address: REGISTRY,
      abi: artistRecordRegistryAbi,
      functionName: "getTokenRanges" as const,
      args: [artist] as const,
    },
    {
      address: REGISTRY,
      abi: artistRecordRegistryAbi,
      functionName: "getSuccessor" as const,
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

  const [rawContracts, rawTokens, rawRanges, rawSuccessor] = results as [
    readonly Address[],
    readonly { contractAddress: Address; tokenId: bigint }[],
    readonly {
      contractAddress: Address
      startTokenId: bigint
      endTokenId: bigint
    }[],
    Address,
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
    successor:
      rawSuccessor === "0x0000000000000000000000000000000000000000"
        ? null
        : rawSuccessor,
  }
}

/**
 * Like `getArtistRecord` but also walks the successor chain forward,
 * returning the list of addresses traversed. Bounded by MAX_DEPTH to
 * defend against on-chain cycles (the contract doesn't enforce cycle
 * prevention — see the registry's NatSpec).
 */
const MAX_SUCCESSOR_DEPTH = 16

export async function getArtistRecordWithChain(
  artist: Address,
): Promise<ArtistRecordWithChain> {
  const base = await getArtistRecord(artist)
  const chain: Address[] = [artist]
  const seen = new Set<string>([artist.toLowerCase()])

  let cursor: Address | null = base.successor
  let depth = 0
  while (cursor && depth < MAX_SUCCESSOR_DEPTH) {
    const lower = cursor.toLowerCase()
    if (seen.has(lower)) break // cycle protection
    seen.add(lower)
    chain.push(cursor)
    const next = await getSuccessorOnly(cursor)
    cursor = next
    depth++
  }

  return { ...base, successorChain: chain }
}

/**
 * Read just an address's declared successor. Used by the chain-walk
 * helper above; one RPC call per hop, but the chain is typically 0–2
 * hops in practice.
 */
async function getSuccessorOnly(addr: Address): Promise<Address | null> {
  if (!REGISTRY) return null
  const client = getClient()
  try {
    const successor = (await client.readContract({
      address: REGISTRY,
      abi: artistRecordRegistryAbi,
      functionName: "getSuccessor",
      args: [addr],
    })) as Address
    return successor === "0x0000000000000000000000000000000000000000"
      ? null
      : successor
  } catch (e) {
    if (isContractMissing(e)) return null
    throw e
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
    abi: artistRecordRegistryAbi,
    functionName: "isOperator",
    args: [artist, operator],
  })) as boolean
}

function emptyRecord(artist: Address): ArtistRecord {
  return {
    artist,
    contracts: [],
    tokens: [],
    tokenRanges: [],
    successor: null,
  }
}

/**
 * Convenience: is this address known to have declared anything? Cheap
 * O(1) check used by the dependency report to decide whether to call
 * the full `getArtistRecord` or skip it.
 */
export async function hasAnyDeclarations(
  artist: Address,
): Promise<boolean> {
  if (!REGISTRY) return false
  const client = getClient()
  const calls = [
    {
      address: REGISTRY,
      abi: artistRecordRegistryAbi,
      functionName: "getContractCount" as const,
      args: [artist] as const,
    },
    {
      address: REGISTRY,
      abi: artistRecordRegistryAbi,
      functionName: "getTokenCount" as const,
      args: [artist] as const,
    },
    {
      address: REGISTRY,
      abi: artistRecordRegistryAbi,
      functionName: "getTokenRangeCount" as const,
      args: [artist] as const,
    },
    {
      address: REGISTRY,
      abi: artistRecordRegistryAbi,
      functionName: "getSuccessor" as const,
      args: [artist] as const,
    },
  ]
  let results
  try {
    results = (await client.multicall({
      contracts: calls,
      allowFailure: false,
    })) as unknown as [bigint, bigint, bigint, Address]
  } catch (e) {
    if (isContractMissing(e)) return false
    throw e
  }
  const [cc, tc, rc, succ] = results
  return (
    cc > 0n ||
    tc > 0n ||
    rc > 0n ||
    succ !== "0x0000000000000000000000000000000000000000"
  )
}
