/**
 * The Irys/Arweave permanent-floor spend rail (Phase 2 of
 * docs/editions-permanence-funding.md).
 *
 * Wraps the EXISTING sovereign storage substrate (lib/storage/arweave.ts) —
 * which already funds Irys in native mainnet ETH from the artist's wallet — in
 * the pluggable SpendRail interface, and adds the honest, EARNED permanence
 * check: the resulting copy is only labeled "permanent-floor" once arweave.net
 * actually serves it. No new Irys integration; this is the rail wrapper + the
 * durability verification.
 *
 * What this rail does NOT do: hold funds or media. The artist's wallet funds
 * and signs the upload (sovereign); the bytes go wallet→Irys; PND custodies
 * nothing. The vault (artist-owned) is where the ETH that funds this came from.
 */

import type { PublicClient, WalletClient } from "viem"
import { estimateArweaveCost, uploadToArweave } from "./storage/arweave"
import {
  arweaveDurability,
  bareArweaveId,
  deriveArweaveUris,
  type RailFundResult,
  type RailQuote,
  type SpendRail,
} from "./editions-rails"

export type IrysQuoteInput = {
  bytes: number
  walletClient: WalletClient
  publicClient: PublicClient
}

export type IrysFundInput = {
  file: File
  walletClient: WalletClient
  publicClient: PublicClient
}

/**
 * Probe whether a URL serves a loadable image, via an <img> load (works without
 * gateway CORS). Mirrors ArtworkInput's imageResolves. Browser-only.
 */
function imageResolves(url: string, timeoutMs = 8000): Promise<boolean> {
  return new Promise((resolve) => {
    if (typeof Image === "undefined") return resolve(false)
    const img = new Image()
    const finish = (ok: boolean) => {
      img.onload = null
      img.onerror = null
      resolve(ok)
    }
    const t = setTimeout(() => finish(false), timeoutMs)
    img.onload = () => {
      clearTimeout(t)
      finish(true)
    }
    img.onerror = () => {
      clearTimeout(t)
      finish(false)
    }
    img.src = url
  })
}

/**
 * Re-check whether an Arweave/Irys id has settled to Arweave by probing
 * arweave.net. Returns the earned durability. arweave.net can lag until the
 * bundle finalizes, so a fresh upload is typically "irys-stored" and upgrades
 * to "permanent-floor" on a later re-check (the Phase 3 decay monitor).
 */
export async function checkArweaveSettlement(idOrUri: string) {
  const id = bareArweaveId(idOrUri)
  const [arweaveResolved, irysResolved] = await Promise.all([
    imageResolves(`https://arweave.net/${id}`),
    imageResolves(`https://gateway.irys.xyz/${id}`),
  ])
  return arweaveDurability({ arweaveResolved, irysResolved })
}

/**
 * The Irys/Arweave floor rail. Pay-once (fundedThrough = null). Funding is
 * native mainnet ETH from the artist's wallet (no bridge, no Base, no USDC).
 */
export const irysArweaveRail: SpendRail<IrysQuoteInput, IrysFundInput> = {
  kind: "irys-arweave",
  targetDurability: "permanent-floor",

  async quote({ bytes, walletClient, publicClient }): Promise<RailQuote> {
    const est = await estimateArweaveCost(bytes, walletClient, publicClient)
    return { bytes: est.bytes, wei: est.wei, isFree: est.isFree, fundedThrough: null }
  },

  async fund({ file, walletClient, publicClient }): Promise<RailFundResult> {
    const result = await uploadToArweave(file, walletClient, publicClient)
    const uris = deriveArweaveUris(result.uri)
    // Earn the durability label from a live resolution check (arweave.net is
    // the proof of Arweave settlement; the Irys gateway serves optimistically).
    const durability = await checkArweaveSettlement(result.uri)
    return { uris, durability, fundedThrough: null, spendTxs: [] }
  },
}
