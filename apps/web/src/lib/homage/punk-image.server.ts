import "server-only"
import {createPublicClient, http, parseAbi, hexToBytes} from "viem"
import {mainnet, sepolia} from "viem/chains"
import {pgCache} from "../pg-cache"

// The classic CryptoPunk pixel image for a punk id — the SOURCE a homage is
// derived from. Reads `punkImage` (2304-byte RGBA) from PunksRenderer
// (renderer.punksdata.eth), the Larva-compatible surface over the sealed
// PunksData set, and builds the 24x24 SVG here. The image is immutable per id,
// so it's cached for a year: the RPC is hit once per punk, ever.
//
// Fork-aware client mirrors detect.server.ts / collection-onchain.ts: always the
// mainnet chain object (canonical Multicall3) with the transport pointed at Anvil
// in fork mode (which forks mainnet, where the punk contracts are deployed).

const PUNKS_DATA_MAINNET = "0x0955B58e38fA8794723AC7B5Ac99d2Df67D55741" as const
// MockPunksData on sepolia — same `punkImage(uint16)` shape, stand-in for the
// real (unwrapped) PunksData set which has no sepolia deployment.
const PUNKS_DATA_SEPOLIA = "0xc2fc154b3ffb9c93ac59738d18f40203522b17ca" as const
const punksDataAbi = parseAbi(["function punkImage(uint16 index) view returns (bytes)"])

const FORK_MODE = process.env.NEXT_PUBLIC_USE_LOCAL_RPC === "1"
// Opt-in sepolia instance (mirrors mint-collections.ts' MINT_CHAIN_ID split).
const USE_SEPOLIA = process.env.NEXT_PUBLIC_USE_SEPOLIA === "1"
const SEPOLIA_RPC_URL =
  process.env.NEXT_PUBLIC_SEPOLIA_RPC_URL || "https://ethereum-sepolia-rpc.publicnode.com"
const PUNKS_DATA = USE_SEPOLIA ? PUNKS_DATA_SEPOLIA : PUNKS_DATA_MAINNET
const ONE_YEAR = 60 * 60 * 24 * 365

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

// 2304 RGBA bytes -> 24x24 SVG: one rect per horizontal same-color run, transparent
// background (consumers paint the ground), semi-transparent pixels keep their alpha
// via fill-opacity. Kept inline so this stays a leaf server module.
function bytesToSvg(img: Uint8Array): string {
  const hex = (c: number) => "#" + (c >>> 0).toString(16).padStart(6, "0")
  let rects = ""
  for (let y = 0; y < 24; y++) {
    let x = 0
    while (x < 24) {
      const o = (y * 24 + x) * 4
      const a = img[o + 3]
      if (a === 0) {
        x++
        continue
      }
      const rgb = (img[o] << 16) | (img[o + 1] << 8) | img[o + 2]
      let run = 1
      while (x + run < 24) {
        const o2 = (y * 24 + x + run) * 4
        if (img[o2 + 3] !== a || ((img[o2] << 16) | (img[o2 + 1] << 8) | img[o2 + 2]) !== rgb) break
        run++
      }
      const op = a === 255 ? "" : ` fill-opacity="${(a / 255).toFixed(3)}"`
      rects += `<rect x="${x}" y="${y}" width="${run}" height="1" fill="${hex(rgb)}"${op}/>`
      x += run
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" shape-rendering="crispEdges">${rects}</svg>`
}

/** `<img>`-ready data URI of the classic CryptoPunk `punkId`, or null. */
export async function getPunkImageSvg(punkId: number): Promise<string | null> {
  if (!Number.isInteger(punkId) || punkId < 0 || punkId > 9999) return null
  // Cache key versioned: v2 = built from punkImage bytes (renderer.punksdata.eth).
  return pgCache(`punk-svg2:${punkId}`, ONE_YEAR, async () => {
    try {
      const bytesHex = await getClient().readContract({
        address: PUNKS_DATA,
        abi: punksDataAbi,
        functionName: "punkImage",
        args: [punkId],
      })
      const img = hexToBytes(bytesHex)
      if (img.length !== 2304) return null
      return "data:image/svg+xml;utf8," + encodeURIComponent(bytesToSvg(img))
    } catch {
      return null
    }
  })
}
