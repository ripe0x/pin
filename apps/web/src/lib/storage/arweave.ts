/**
 * Account-less Arweave storage for PND Editions, via Irys.
 *
 * Sovereign by construction: PND holds no key and no funds. The artist's own
 * connected wallet signs (and, for files at or above the free tier, funds)
 * the upload. Uploads under 100 KiB are free (no funding transaction). This is
 * the default account-less backend for the editions create flow.
 *
 * NOTE on permanence: Irys's documented behavior is permanent storage on
 * Arweave, but Irys has since launched its own L1, and whether the current
 * `uploader.irys.xyz` endpoint still settles to Arweave (arweave.net-
 * resolvable) is not yet confirmed by a live upload from this codebase. Until
 * it is, the UI frames this as "via Irys" and does not promise permanence; the
 * honest-status check only reports "retrievable" when the bytes actually load.
 * Confirm with one sub-100 KB upload (check gateway.irys.xyz/<id> AND
 * arweave.net/<id> resolve) before leaning on a "permanent" claim publicly.
 *
 * The Irys browser SDK (`@irys/web-upload` + the Ethereum/viem-v2 adapter)
 * pulls a large dependency tree and uses Buffer/crypto, so it is dynamically
 * imported here: it stays out of the initial bundle and never evaluates
 * during SSR; it loads only when an artist actually uploads to Arweave.
 *
 * API verified against the Irys js-sdk source (Irys-xyz/js-sdk):
 *   WebUploader(WebEthereum).withAdapter(ViemV2Adapter(walletClient, { publicClient }))
 *   uploader.getPrice(bytes) -> BigNumber (atomic units = wei for ETH funding)
 *   uploader.getBalance()    -> BigNumber
 *   uploader.fund(amount)
 *   uploader.uploadFile(file) -> { id, ... }   (retrievable at gateway/<id>)
 */

import type { PublicClient, WalletClient } from "viem"
import type { StorageUploadResult } from "./types"

/** Irys serves uploaded data immediately at this gateway. */
const IRYS_GATEWAY = "https://gateway.irys.xyz"

/**
 * Irys waives the fee for uploads under 100 KiB; they store permanently with
 * no funding transaction. At or above this size the wallet must fund the node.
 */
export const IRYS_FREE_LIMIT_BYTES = 100 * 1024

/**
 * Build an Irys browser uploader from a connected wagmi/viem wallet client.
 * Funding token is native ETH on Ethereum mainnet (`WebEthereum`), matching
 * Editions' mainnet-only, ETH-denominated model.
 */
async function getIrysUploader(
  walletClient: WalletClient,
  publicClient: PublicClient,
) {
  const [{ WebUploader }, { WebEthereum }, { ViemV2Adapter }] =
    await Promise.all([
      import("@irys/web-upload"),
      import("@irys/web-upload-ethereum"),
      import("@irys/web-upload-ethereum-viem-v2"),
    ])
  return await WebUploader(WebEthereum).withAdapter(
    // wagmi's generic client types are structurally compatible with the
    // adapter's viem v2 expectations; the SDK's looser parameter types
    // trigger a generic-variance mismatch, so narrow here.
    ViemV2Adapter(walletClient as never, { publicClient: publicClient as never }),
  )
}

export type ArweaveCostEstimate = {
  bytes: number
  /** True when under the 100 KiB free tier (no funding tx). */
  isFree: boolean
  /** Storage cost in wei (native ETH funding). 0n when free. */
  wei: bigint
}

/**
 * Estimate the Arweave storage cost for `bytes`, paid from the artist's wallet
 * in ETH. Honest-cost rule: this is a one-time storage cost, separate from the
 * edition deploy gas. Under 100 KiB it is free and queries nothing.
 */
export async function estimateArweaveCost(
  bytes: number,
  walletClient: WalletClient,
  publicClient: PublicClient,
): Promise<ArweaveCostEstimate> {
  if (bytes < IRYS_FREE_LIMIT_BYTES) return { bytes, isFree: true, wei: 0n }
  const irys = await getIrysUploader(walletClient, publicClient)
  const price = await irys.getPrice(bytes)
  return { bytes, isFree: false, wei: BigInt(price.toFixed(0)) }
}

/**
 * Upload a file to Arweave via Irys, paid from the connected wallet. Returns
 * the `ar://<id>` URI to persist as `artworkURI`, plus the Irys gateway URL
 * that resolves the bytes immediately (preview against `gatewayUrl`, since
 * arweave.net can lag until the bundle finalizes).
 */
export async function uploadToArweave(
  file: File,
  walletClient: WalletClient,
  publicClient: PublicClient,
): Promise<StorageUploadResult> {
  const irys = await getIrysUploader(walletClient, publicClient)

  // Fund only when the file is at/over the free tier and the loaded balance is
  // short — keeps free (<100 KiB) uploads to a single signature, no tx.
  if (file.size >= IRYS_FREE_LIMIT_BYTES) {
    const price = await irys.getPrice(file.size)
    const balance = await irys.getBalance()
    if (balance.lt(price)) {
      await irys.fund(price.minus(balance))
    }
  }

  const receipt = await irys.uploadFile(file)
  const id = receipt?.id
  if (!id) throw new Error("Irys upload returned no transaction id")
  return {
    backend: "arweave",
    uri: `ar://${id}`,
    gatewayUrl: `${IRYS_GATEWAY}/${id}`,
    bytes: file.size,
  }
}
