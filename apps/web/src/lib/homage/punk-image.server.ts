import "server-only"
import {createPublicClient, http, parseAbi} from "viem"
import {mainnet} from "viem/chains"
import {pgCache} from "../pg-cache"

// The classic CryptoPunk pixel image for a punk id — the SOURCE a homage is
// derived from. Read from the on-chain CryptoPunksData registry (`punkImageSvg`
// returns a `data:image/svg+xml;utf8,<svg…>` string). The image is immutable per
// id, so it's cached for a year: the RPC is hit once per punk, ever.
//
// Fork-aware client mirrors detect.server.ts / collection-onchain.ts: always the
// mainnet chain object (canonical Multicall3) with the transport pointed at Anvil
// in fork mode (which forks mainnet, where CryptoPunksData is deployed).

const CRYPTOPUNKS_DATA = "0x16f5a35647d6f03d5d3da7b35409d65ba03af3b2" as const
const punksDataAbi = parseAbi(["function punkImageSvg(uint16 index) view returns (string svg)"])

const FORK_MODE = process.env.NEXT_PUBLIC_USE_LOCAL_RPC === "1"
const ONE_YEAR = 60 * 60 * 24 * 365

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

// CryptoPunksData returns the SVG body unescaped after `…utf8,`; a raw `#` or `"`
// truncates it inside an <img src>. Re-encode the body so it drops straight into
// an <img>/<a> (mirrors homage-gallery/svg.ts `anySvgToSrc`, kept inline so this
// stays a leaf server module).
function toImgSrc(svg: string): string {
  const utf8Prefix = "data:image/svg+xml;utf8,"
  if (svg.startsWith(utf8Prefix)) {
    return utf8Prefix + encodeURIComponent(svg.slice(utf8Prefix.length))
  }
  if (svg.startsWith("data:")) return svg
  return utf8Prefix + encodeURIComponent(svg)
}

/** `<img>`-ready data URI of the classic CryptoPunk `punkId`, or null. */
export async function getPunkImageSvg(punkId: number): Promise<string | null> {
  if (!Number.isInteger(punkId) || punkId < 0 || punkId > 9999) return null
  return pgCache(`punk-svg:${punkId}`, ONE_YEAR, async () => {
    try {
      const svg = await getClient().readContract({
        address: CRYPTOPUNKS_DATA,
        abi: punksDataAbi,
        functionName: "punkImageSvg",
        args: [punkId],
      })
      return typeof svg === "string" && svg.length > 0 ? toImgSrc(svg) : null
    } catch {
      return null
    }
  })
}
