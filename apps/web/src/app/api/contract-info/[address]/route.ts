import { NextRequest, NextResponse } from "next/server"
import { unstable_cache } from "next/cache"
import { createPublicClient, type Address } from "viem"
import { mainnet } from "viem/chains"
import { pgCache } from "@/lib/pg-cache"
import { checkRateLimit, getClientIp } from "@/lib/rate-limit"
import { loggingFallbackTransport } from "@/lib/rpc-log"

/**
 * Lightweight contract sanity-check used by the /record Add form so
 * the artist sees what they're about to declare before they confirm.
 *
 * Returns:
 *   - whether the address has any deployed bytecode
 *   - name / symbol when implemented
 *   - which ERC standard the contract claims (721 / 1155 / both)
 *   - totalSupply when implemented (ERC-721 enumerable)
 *
 * Every read tolerates failure individually — many older or
 * minimalist contracts don't implement name(), totalSupply(),
 * or supportsInterface. We surface what we can and leave the rest
 * blank.
 *
 * Cached 1h per address. Contract identity doesn't change; the only
 * thing that drifts is totalSupply for actively-minting collections,
 * which is fine to be slightly stale for a confidence-check preview.
 */

const ERC165_ABI = [
  {
    type: "function",
    name: "supportsInterface",
    stateMutability: "view",
    inputs: [{ name: "interfaceId", type: "bytes4" }],
    outputs: [{ type: "bool" }],
  },
] as const

const NAME_SYMBOL_ABI = [
  {
    type: "function",
    name: "name",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "string" }],
  },
  {
    type: "function",
    name: "symbol",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "string" }],
  },
  {
    type: "function",
    name: "totalSupply",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
] as const

const ERC721_INTERFACE = "0x80ac58cd"
const ERC1155_INTERFACE = "0xd9b67a26"

export type ContractInfo = {
  address: string
  hasBytecode: boolean
  name: string | null
  symbol: string | null
  totalSupply: string | null
  isERC721: boolean
  isERC1155: boolean
}

const TTL_S = 60 * 60

function getClient() {
  return createPublicClient({
    chain: mainnet,
    transport: loggingFallbackTransport("contract-info"),
  })
}

async function fetchContractInfo(address: Address): Promise<ContractInfo> {
  const client = getClient()

  // Code check + interface probes + name/symbol/totalSupply in one
  // multicall. allowFailure: true so missing functions don't sink
  // the whole read.
  const [bytecode, multicallResults] = await Promise.all([
    client.getBytecode({ address }).catch(() => undefined),
    client.multicall({
      allowFailure: true,
      contracts: [
        {
          address,
          abi: ERC165_ABI,
          functionName: "supportsInterface" as const,
          args: [ERC721_INTERFACE] as const,
        },
        {
          address,
          abi: ERC165_ABI,
          functionName: "supportsInterface" as const,
          args: [ERC1155_INTERFACE] as const,
        },
        {
          address,
          abi: NAME_SYMBOL_ABI,
          functionName: "name" as const,
        },
        {
          address,
          abi: NAME_SYMBOL_ABI,
          functionName: "symbol" as const,
        },
        {
          address,
          abi: NAME_SYMBOL_ABI,
          functionName: "totalSupply" as const,
        },
      ],
    }),
  ])

  const [
    isERC721Result,
    isERC1155Result,
    nameResult,
    symbolResult,
    totalSupplyResult,
  ] = multicallResults

  return {
    address: address.toLowerCase(),
    hasBytecode: !!bytecode && bytecode !== "0x",
    isERC721:
      isERC721Result.status === "success" && isERC721Result.result === true,
    isERC1155:
      isERC1155Result.status === "success" && isERC1155Result.result === true,
    name:
      nameResult.status === "success" && typeof nameResult.result === "string"
        ? nameResult.result
        : null,
    symbol:
      symbolResult.status === "success" &&
      typeof symbolResult.result === "string"
        ? symbolResult.result
        : null,
    totalSupply:
      totalSupplyResult.status === "success" &&
      typeof totalSupplyResult.result === "bigint"
        ? totalSupplyResult.result.toString()
        : null,
  }
}

const cached = unstable_cache(
  (addressLower: string) =>
    pgCache<ContractInfo>(
      `contract-info:${addressLower}`,
      TTL_S,
      () => fetchContractInfo(addressLower as Address),
    ),
  ["contract-info-v1"],
  { revalidate: TTL_S, tags: ["contract-info"] },
)

export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ address: string }> },
): Promise<NextResponse<ContractInfo | { error: string }>> {
  const { address } = await ctx.params

  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) {
    return NextResponse.json({ error: "invalid address" }, { status: 400 })
  }

  const ip = getClientIp(req)
  const rl = checkRateLimit("contract-info", ip, 60_000, 60)
  if (!rl.ok) {
    return NextResponse.json(
      { error: "rate-limited" },
      { status: 429, headers: { "Retry-After": String(rl.retryAfter) } },
    )
  }

  try {
    const data = await cached(address.toLowerCase())
    return NextResponse.json(data, {
      headers: { "Cache-Control": "private, max-age=300" },
    })
  } catch (err) {
    console.error("contract-info failed:", err)
    return NextResponse.json({ error: "lookup failed" }, { status: 500 })
  }
}
