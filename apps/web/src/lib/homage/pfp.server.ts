import "server-only"
import {createPublicClient, http, type Address} from "viem"
import {mainnet, sepolia} from "viem/chains"
import {homageRendererViewAbi} from "./contracts"
import {pgCache} from "../pg-cache"

// The CANONICAL PFP form, read from the renderer contract itself:
// HomageRenderer.renderSVG(id, status, circle=true) — the nest rendered as inscribed
// circles (same centers, radii, colors, and order as the classic squares). The client
// transform in lib/homage/art.ts is its zero-RPC mirror; this read is the source of
// truth and is preferred when it succeeds. Cached briefly, NOT forever: the ground
// tracks the punk's live market status. Falls back to null (→ client mirror) on any
// error.

const FORK_MODE = process.env.NEXT_PUBLIC_USE_LOCAL_RPC === "1"
// Opt-in sepolia instance (mirrors mint-collections.ts' MINT_CHAIN_ID split).
const USE_SEPOLIA = process.env.NEXT_PUBLIC_USE_SEPOLIA === "1"
const SEPOLIA_RPC_URL =
  process.env.NEXT_PUBLIC_SEPOLIA_RPC_URL || "https://ethereum-sepolia-rpc.publicnode.com"
const STATUS_LIVE = 255
const TTL = 60 * 10 // 10 min — status-sensitive, not immutable

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

/** `<img>`-ready data URI of the on-chain PFP render for `punkId`, or null. */
export async function getOnchainPfpSrc(renderer: Address, punkId: number): Promise<string | null> {
  if (!Number.isInteger(punkId) || punkId < 0 || punkId > 9999) return null
  // Key prefix busts entries cached from the retired pfpSVG (plinth) read.
  return pgCache(`pfp-circle:${renderer.toLowerCase()}:${punkId}`, TTL, async () => {
    try {
      const svg = await getClient().readContract({
        address: renderer,
        abi: homageRendererViewAbi,
        functionName: "renderSVG",
        args: [BigInt(punkId), STATUS_LIVE, true],
      })
      return typeof svg === "string" && svg.startsWith("<svg")
        ? `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`
        : null
    } catch {
      return null // read failed → client mirror
    }
  })
}
