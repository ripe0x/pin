import "server-only"
import { createPublicClient, decodeFunctionResult, encodeFunctionData, http, type Address } from "viem"
import { mainnet } from "viem/chains"
import { pgCache, pgCacheHas } from "./pg-cache"

/**
 * Offchain assembly of the "escape (blue)" artwork document.
 *
 * The work's own tokenURI is unreadable over RPC: it concatenates the audio,
 * the image and Tone.js into one ~7.4MB string and base64s the result, which
 * measures at 5.45 BILLION gas in its fully-onchain mode. No provider serves
 * an eth_call that large (Alchemy caps around 550M), so the token renders
 * nowhere, PND included.
 *
 * Every piece it assembles is cheap on its own, though, and the contracts
 * expose them individually. So this reads the parts and does the concatenation
 * here instead:
 *
 *   buildHTML("__FILE__", "__SCRIPT__")            81k    the HTML shell
 *   generateScriptModular([...], pan, "__IMG__")   41k    the work's script
 *   getTonejs()                                   380k    the Tone.js tags
 *   GetStems(true, true) | foc.getAudio()          56k | 4.1M   the audio
 *   getImageHiRes() | getImageFoc()                38k | 65.6M  the still
 *
 * Both the shell and the script come back from the artist's own contracts
 * with placeholders in them, so the markup is his, not a copy of it that
 * could drift. This only substitutes the media he would have inlined.
 *
 * Worst case (fully onchain) is about 70M gas across separate calls against a
 * 5.45B single call. Hi-res mode totals under 1M.
 *
 * This is deliberately specific to one work. It exists because the artist's
 * piece is already deployed and immutable in this shape; the general fix is
 * for a renderer to return a pointer instead of inlining megabytes, which
 * keeps tokenURI readable for marketplaces too (see the launch doc).
 */

/**
 * These reads need a provider that will run a ~65M gas eth_call: the onchain
 * still alone costs that much. Measured against the work: publicnode serves
 * it, drpc answers "out of gas", and Tenderly's public gateway times out. The
 * app's usual client points at whichever of those is configured, so this pins
 * its own rather than inheriting one that cannot do the job.
 */
const ESCAPE_RPC_URL = process.env.ESCAPE_RPC_URL || "https://ethereum-rpc.publicnode.com"

export function getEscapeClient() {
  return createPublicClient({ chain: mainnet, transport: http(ESCAPE_RPC_URL) })
}

/** The engines the work delegates to. Fixed: only the front contract, the
 *  one a collection points at, gets redeployed per release. */
const ESCAPE_RENDERER_HINT = (process.env.ESCAPE_RENDERER_ADDRESS ??
  "0x538ffA56d568Dfb373Baf15d099E610b4a9a00D5") as Address

/** The engine the work delegates its script and hi-res stems to. */
const ESCAPE_HIRES = (process.env.ESCAPE_HIRES_ADDRESS ??
  "0x3caFf319953Df3025A8C73Cf559057BC939Cea8c") as Address

/** The engine holding the fully-onchain audio. */
const ESCAPE_FOC = (process.env.ESCAPE_FOC_ADDRESS ??
  "0x2232f999C4e9Af03e8369892b5242036A5c48F64") as Address

/**
 * Whether a renderer is one of these, detected by shape rather than by
 * address. The artist redeploys the same contract per release (a second
 * instance is already live), so an address list would need editing every
 * time and the collection would silently fall back to a tokenURI that
 * cannot run. `buildHTML(string,string)` answering alongside
 * `tokenToFOCMode(uint256)` is particular enough to identify it, and both
 * are cheap. Cached for a day: a given address either is this contract or
 * never will be.
 */
/**
 * The work's description, mirrored from the string literal inside its
 * tokenURI ('"description":"go right ahead"'). tokenURI cannot be read (it is
 * the 5.45B gas call) and the string is not exposed by any getter, so this is
 * the one place its copy lives. If the artist changes the copy he redeploys
 * the renderer, at which point this is updated alongside. Only this one static
 * string is mirrored, never the markup, which is assembled from his contracts.
 */
export const ESCAPE_DESCRIPTION = "go right ahead"

export async function isEscapeRenderer(renderer: string): Promise<boolean> {
  const addr = renderer.toLowerCase() as Address
  if (addr === ESCAPE_RENDERER_HINT.toLowerCase()) return true
  // A confirmed match is cached for a day (a renderer that is this contract
  // stays this contract). A miss is cached only briefly, so a transient probe
  // failure never locks a real escape renderer out of its assembler for a day
  // (which is exactly what left the page empty after a renderer swap). Split
  // keys, so this also orphans any stale single-key entry from before.
  const yes = `escape-shape:${addr}:yes`
  const no = `escape-shape:${addr}:no`
  if (await pgCacheHas(yes)) return true
  if (await pgCacheHas(no)) return false
  const client = getEscapeClient()
  try {
    await read<string>(client, addr, abi, "buildHTML", ["a", "b"])
    await read<boolean>(client, addr, abi, "tokenToFOCMode", [1n])
    await pgCache(yes, 86_400, async () => true)
    return true
  } catch {
    await pgCache(no, 300, async () => true)
    return false
  }
}

const abi = [
  { type: "function", name: "buildHTML", stateMutability: "pure", inputs: [{ type: "string" }, { type: "string" }], outputs: [{ type: "string" }] },
  { type: "function", name: "getTonejs", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { type: "function", name: "getImageFoc", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { type: "function", name: "getImageHiRes", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { type: "function", name: "getImage", stateMutability: "view", inputs: [{ type: "uint256" }], outputs: [{ type: "string" }] },
  { type: "function", name: "tokenToFOCMode", stateMutability: "view", inputs: [{ type: "uint256" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "bgColor", stateMutability: "view", inputs: [], outputs: [{ type: "bytes" }] },
  { type: "function", name: "panPosFoc", stateMutability: "view", inputs: [{ type: "uint256" }], outputs: [{ type: "int256" }] },
  { type: "function", name: "panPosHiRes", stateMutability: "view", inputs: [{ type: "uint256" }], outputs: [{ type: "int256" }] },
  { type: "function", name: "generateTraits", stateMutability: "view", inputs: [{ type: "uint256" }], outputs: [{ type: "string" }] },
] as const

const hiResAbi = [
  { type: "function", name: "GetStems", stateMutability: "view", inputs: [{ type: "bool" }, { type: "bool" }], outputs: [{ type: "string[]" }] },
  {
    type: "function",
    name: "generateScriptModular",
    stateMutability: "view",
    inputs: [{ type: "string[]" }, { type: "int256[]" }, { type: "string" }, { type: "bytes" }],
    outputs: [{ type: "string" }],
  },
] as const

const focAbi = [
  { type: "function", name: "getAudio", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
] as const

type Client = {
  call: (args: { to: Address; data: `0x${string}`; gas?: bigint }) => Promise<{ data?: `0x${string}` }>
}

/** One high-gas eth_call, decoded. These reads are individually large (the
 *  onchain still is ~65M) but nowhere near a provider's ceiling. */
async function read<T>(
  client: Client,
  to: Address,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  contractAbi: any,
  functionName: string,
  args: readonly unknown[] = [],
): Promise<T> {
  const { data } = await client.call({
    to,
    data: encodeFunctionData({ abi: contractAbi, functionName, args }),
    gas: 300_000_000n,
  })
  if (!data) throw new Error(`empty result from ${functionName}`)
  return decodeFunctionResult({ abi: contractAbi, functionName, data }) as T
}

export type EscapeArtwork = {
  /** The still: an Arweave URL in hi-res mode, an inline data URI onchain. */
  image: string
  /** The assembled interactive document. */
  html: string
  focMode: boolean
}

/**
 * Assemble one token's document. Cached for a day keyed on the token and its
 * mode, since the output only changes when the holder flips that mode (which
 * bumps the key rather than needing invalidation).
 */
export async function buildEscapeArtwork(
  renderer: Address,
  tokenId: bigint,
): Promise<EscapeArtwork | null> {
  const client = getEscapeClient()
  const focMode = await read<boolean>(client, renderer, abi, "tokenToFOCMode", [tokenId]).catch(
    () => null,
  )
  if (focMode === null) return null

  // v2: the key is versioned so a fix to the assembly orphans stale entries
  // (including any failure cached under an older scheme) rather than serving
  // them for a day. The fetcher is allowed to throw — pgCache does not write
  // on a throw, so a transient read failure is retried next request instead
  // of being cached as "no artwork".
  try {
    return await pgCache(
      `escape-art:v2:${tokenId.toString()}:${renderer.toLowerCase()}:${focMode ? "foc" : "hires"}`,
      86_400,
      async () => {
      const [shellB64, tonejs, bgColor] = await Promise.all([
        read<string>(client, renderer, abi, "buildHTML", ["__FILE__", "__SCRIPT__"]),
        read<string>(client, renderer, abi, "getTonejs"),
        read<`0x${string}`>(client, renderer, abi, "bgColor"),
      ])

      // Pan positions and stems come in matching lengths: one entry per stem.
      // Fully-onchain mode plays a single mixed file; hi-res streams the
      // separate stems the engine points at.
      const stems: string[] = focMode
        ? [`data:audio/mp3;base64,${await read<string>(client, ESCAPE_FOC, focAbi, "getAudio")}`]
        : await read<string[]>(client, ESCAPE_HIRES, hiResAbi, "GetStems", [true, true])

      const pan: bigint[] = await Promise.all(
        stems.map((_, i) =>
          read<bigint>(client, renderer, abi, focMode ? "panPosFoc" : "panPosHiRes", [BigInt(i)]),
        ),
      )

      // The image the work chooses for this token: getImage resolves the
      // source itself (onchain still vs hi-res), so this follows the contract
      // rather than second-guessing it, and survives the artist swapping what
      // getImage returns (a still replacing the fully-onchain gif is exactly
      // what broke the old mode-branched read).
      const image = await read<string>(client, renderer, abi, "getImage", [tokenId])

      // Ask the engine for its script with placeholders where the media goes,
      // so the script stays the artist's own rather than a reimplementation.
      const stemSlots = stems.map((_, i) => `__STEM${i}__`)
      let script = await read<string>(client, ESCAPE_HIRES, hiResAbi, "generateScriptModular", [
        stemSlots,
        pan,
        "__IMG__",
        bgColor,
      ])
      stems.forEach((s, i) => {
        script = script.split(`__STEM${i}__`).join(s)
      })
      script = script.split("__IMG__").join(image)

      const shell = Buffer.from(shellB64, "base64").toString("utf8")
      const html = shell.split("__FILE__").join(tonejs).split("__SCRIPT__").join(script)

      return { image, html, focMode }
      },
    )
  } catch {
    return null
  }
}
