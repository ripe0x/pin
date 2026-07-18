import "server-only"
import {createPublicClient, http, type Address} from "viem"
import {mainnet} from "viem/chains"
import {homageRendererViewAbi} from "./contracts"
import {pgCache} from "../pg-cache"

// The CANONICAL PFP form, read from the renderer contract itself
// (HomageRenderer.pfpSVG — the classic nest re-framed under one constant affine with a
// dominant-colour plinth). The client transform in lib/homage/art.ts is its zero-RPC
// mirror; this read is the source of truth and is preferred when the deployed renderer
// exposes it. Cached briefly, NOT forever: the ground tracks the punk's live market
// status. Falls back to null (→ client mirror) on any error, including a renderer
// deployed before pfpSVG existed.

const FORK_MODE = process.env.NEXT_PUBLIC_USE_LOCAL_RPC === "1"
const STATUS_LIVE = 255
const TTL = 60 * 10 // 10 min — status-sensitive, not immutable

function getClient() {
  if (FORK_MODE) {
    const url = process.env.NEXT_PUBLIC_ANVIL_RPC_URL || "http://127.0.0.1:8545"
    return createPublicClient({chain: mainnet, transport: http(url)})
  }
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
  return pgCache(`pfp-svg:${renderer.toLowerCase()}:${punkId}`, TTL, async () => {
    try {
      const svg = await getClient().readContract({
        address: renderer,
        abi: homageRendererViewAbi,
        functionName: "pfpSVG",
        args: [BigInt(punkId), STATUS_LIVE],
      })
      return typeof svg === "string" && svg.startsWith("<svg")
        ? `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`
        : null
    } catch {
      return null // renderer predates pfpSVG, or read failed → client mirror
    }
  })
}
