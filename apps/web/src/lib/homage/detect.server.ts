import "server-only"
import {createPublicClient, http, type Address} from "viem"
import {mainnet, sepolia} from "viem/chains"
import {homageMinterFor} from "./registry"
import {homageMinterAbi} from "./contracts"

// Fork-aware server client (mirrors collection-onchain.ts getClient). Always the
// mainnet chain object so viem resolves the canonical Multicall3; in fork mode the
// transport points at Anvil (which forks mainnet).
const FORK_MODE = process.env.NEXT_PUBLIC_USE_LOCAL_RPC === "1"
// Opt-in sepolia instance (mirrors mint-collections.ts' MINT_CHAIN_ID split).
const USE_SEPOLIA = process.env.NEXT_PUBLIC_USE_SEPOLIA === "1"
const SEPOLIA_RPC_URL =
  process.env.NEXT_PUBLIC_SEPOLIA_RPC_URL || "https://ethereum-sepolia-rpc.publicnode.com"

function getClient() {
  if (FORK_MODE) {
    const url = process.env.NEXT_PUBLIC_ANVIL_RPC_URL || "http://127.0.0.1:8545"
    return createPublicClient({chain: mainnet, transport: http(url)})
  }
  if (USE_SEPOLIA) return createPublicClient({chain: sepolia, transport: http(SEPOLIA_RPC_URL)})
  const explicit = process.env.ALCHEMY_MAINNET_URL
  if (explicit) return createPublicClient({chain: mainnet, transport: http(explicit)})
  const key = process.env.ALCHEMY_API_KEY
  const url =
    key && !key.startsWith("set-")
      ? `https://eth-mainnet.g.alchemy.com/v2/${key}`
      : "https://eth.drpc.org"
  return createPublicClient({chain: mainnet, transport: http(url)})
}

/**
 * If `collection` is a registered homage collection whose registered HomageMinter
 * actually back-references it on-chain, return that minter address; otherwise null.
 *
 * The registry is the curated allowlist; the on-chain `minter.collection()` check
 * is the safety interlock, so a stale/misconfigured env can only fail closed (no
 * homage UI) — never surface a mint against the wrong contract.
 */
export async function detectHomageMinter(collection: Address, chainId: number): Promise<Address | null> {
  const minter = homageMinterFor(collection, chainId)
  if (!minter) return null
  try {
    const backref = (await getClient().readContract({
      address: minter,
      abi: homageMinterAbi,
      functionName: "collection",
    })) as Address
    return backref.toLowerCase() === collection.toLowerCase() ? minter : null
  } catch {
    // Not a HomageMinter (no collection() getter) or RPC failure → fail closed.
    return null
  }
}
