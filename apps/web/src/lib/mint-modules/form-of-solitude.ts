/**
 * Form of Solitude (Anton Dubrovin): a Surface v2 collection launched from
 * the mainnet Launcher, sold by its FixedPriceSale. The artwork is onchain
 * WebGL HTML (tokenURI animation_url); token images are RenderAssets
 * captures (hosted PNGs, later ar://).
 *
 * Addresses are mainnet constants, so the descriptor needs no env and works
 * unchanged against a mainnet fork. Importing this module registers its args
 * builder (the side-effect pattern mint-registries.ts documents).
 */
import { type Abi, type Address, zeroAddress } from "viem"
import { fixedPriceSaleAbi, renderAssetsAbi, surfaceTokenV2Abi } from "@pin/abi"
import { arweaveToHttp } from "@pin/shared"
import type { MintCollection } from "../mint-collections"
import { registerArgsBuilder } from "../mint-registries"

const SALE: Address = "0x86a1de6c3136dc5a421ac8372ec9e05e1c533dff"
const TOKEN: Address = "0x4490f1dadefa3234961404f5cc58056296eb4a89"
const RENDER_ASSETS: Address = "0x34D384646a44EbeA51f07C1Fa888E469483e25fB"
const COVER = "ar://SDfMqsvl5tykH224bFG1W0x3G_AQg0wonJXsORc-X3c"

// PND mints normally pay the sale's 5% default referral to PND. This one
// collection is exempt (Dave, 2026-11-02): PND already takes 20% of its
// proceeds through the 80/20 payout split, so it mints with no referrer.
// Do not copy this to other collections.
registerArgsBuilder("form-of-solitude", ({ wallet, quantity }) => {
  if (!wallet) throw new Error("Connect a wallet first")
  return { fn: "mintWithReferral", args: [wallet, BigInt(quantity), zeroAddress, "0x"] }
})

export function formOfSolitudeCollection(chainId: number): MintCollection | null {
  if (chainId === 11155111) return null // mainnet collection; no Sepolia twin
  return {
    slug: "form-of-solitude",
    name: "Form of Solitude",
    description:
      "A fully onchain generative work by Anton Dubrovin, drawn live with WebGL. Each piece's form and colour come from its seed, and pieces held in the same wallet move to one shared rhythm.",
    chainId,
    address: SALE,
    abi: fixedPriceSaleAbi as unknown as Abi,
    tokenContract: { address: TOKEN, abi: surfaceTokenV2Abi as unknown as Abi },
    mintedFn: "totalMinted",
    // ponytail: the token's own supplyCap is 256 and the sale sets no
    // maxMints; read Surface.config() if the owner ever changes the cap.
    cap: { kind: "const", value: 256n },
    price: { kind: "getter", fn: "price" },
    window: { kind: "start-end", startFn: "mintStart", endFn: "mintEnd" },
    alreadyMintedFn: null,
    mintFn: "mint", // overridden to mintWithReferral by the args builder
    quantity: true,
    argsBuilder: "form-of-solitude",
    reveal: { kind: "transfer-log" },
    layout: "standard",
    // A static cover: tokenURI needs a minted token, and none exists before the mint opens.
    hero: { kind: "static", url: arweaveToHttp(COVER) },
    identityFromHero: false,
    galleryImage: { address: RENDER_ASSETS, abi: renderAssetsAbi as unknown as Abi, fn: "imageFor" },
    tokenNoun: "piece",
    heroAspect: "1 / 1",
    pieceAspect: "1 / 1",
  }
}
