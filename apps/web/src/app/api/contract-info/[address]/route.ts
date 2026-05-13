import { NextRequest, NextResponse } from "next/server"
import { unstable_cache } from "next/cache"
import { createPublicClient, type Address } from "viem"
import { mainnet } from "viem/chains"
import { pgCache } from "@/lib/pg-cache"
import { checkRateLimit, getClientIp } from "@/lib/rate-limit"
import { loggingFallbackTransport } from "@/lib/rpc-log"
import {
  readContractIdentity,
  writeContractIdentity,
  type StoredContractIdentity,
} from "@/lib/contract-identity-store"

/**
 * Lightweight contract sanity-check used by the /record Add form and
 * the /record list pages.
 *
 * Returns:
 *   - whether the address has any deployed bytecode
 *   - name / symbol when implemented
 *   - which ERC standard the contract claims (721 / 1155 / both)
 *   - totalSupply when implemented (ERC-721 enumerable)
 *
 * Two-tier caching:
 *   1. Identity (name, symbol, has_bytecode, ERC standard) — persistent
 *      index in the `contract_identity` table. Rows live forever once
 *      written; one on-chain probe per address ever. See
 *      `contract-identity-store.ts` and migration 021.
 *   2. totalSupply — short-TTL pgCache. Supply mutates on every mint,
 *      so we re-read on a short cycle. The record list pages don't read
 *      this column, so most callers never trigger the supply path.
 *
 * Every read tolerates failure individually — many older or minimalist
 * contracts don't implement name(), totalSupply(), or supportsInterface.
 * We surface what we can and leave the rest blank.
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

const SUPPLY_TTL_S = 5 * 60

function getClient() {
  return createPublicClient({
    chain: mainnet,
    transport: loggingFallbackTransport("contract-info"),
  })
}

/**
 * One-shot multicall + bytecode read against the chain. Used on a
 * persistent-index miss (every value gets persisted, no re-fetch later)
 * AND for the standalone supply refresh path.
 */
async function probeContractIdentity(address: Address): Promise<
  StoredContractIdentity & { totalSupply: string | null }
> {
  const client = getClient()

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
    fetchedAt: new Date(),
  }
}

/**
 * Read just the supply, cached on a short TTL. Used after identity has
 * been resolved (cheap point read against the table) — the eth_call here
 * is the only RPC cost on a warm record-list render that needs supply.
 */
async function readSupplyOnly(address: Address): Promise<string | null> {
  const client = getClient()
  try {
    const supply = await client.readContract({
      address,
      abi: NAME_SYMBOL_ABI,
      functionName: "totalSupply",
    })
    return typeof supply === "bigint" ? supply.toString() : null
  } catch {
    return null
  }
}

const cachedSupply = unstable_cache(
  (addressLower: string) =>
    pgCache<string | null>(
      `contract-supply:${addressLower}`,
      SUPPLY_TTL_S,
      () => readSupplyOnly(addressLower as Address),
    ),
  ["contract-supply-v1"],
  { revalidate: SUPPLY_TTL_S, tags: ["contract-supply"] },
)

async function resolveContractInfo(address: string): Promise<ContractInfo> {
  const lower = address.toLowerCase()

  // Fast path: persistent identity index. One Postgres point read.
  const stored = await readContractIdentity(lower)
  if (stored) {
    // Identity served from the index; supply layered on top (short TTL).
    // Skip the supply read entirely if the contract has no bytecode —
    // it'd revert anyway, and we already know that's the answer.
    const supply = stored.hasBytecode ? await cachedSupply(lower) : null
    return {
      address: lower,
      hasBytecode: stored.hasBytecode,
      name: stored.name,
      symbol: stored.symbol,
      totalSupply: supply,
      isERC721: stored.isERC721,
      isERC1155: stored.isERC1155,
    }
  }

  // Cold path: never seen this address. One multicall + bytecode read,
  // persist identity to the index, return everything.
  const probed = await probeContractIdentity(lower as Address)
  writeContractIdentity(lower, {
    name: probed.name,
    symbol: probed.symbol,
    hasBytecode: probed.hasBytecode,
    isERC721: probed.isERC721,
    isERC1155: probed.isERC1155,
  })
  return {
    address: lower,
    hasBytecode: probed.hasBytecode,
    name: probed.name,
    symbol: probed.symbol,
    totalSupply: probed.totalSupply,
    isERC721: probed.isERC721,
    isERC1155: probed.isERC1155,
  }
}

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
    const data = await resolveContractInfo(address)
    return NextResponse.json(data, {
      headers: { "Cache-Control": "private, max-age=300" },
    })
  } catch (err) {
    console.error("contract-info failed:", err)
    return NextResponse.json({ error: "lookup failed" }, { status: 500 })
  }
}
