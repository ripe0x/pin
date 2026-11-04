/**
 * Mint transaction building and revert decoding for the Surface mint card.
 * Pure (no React, no server-only), so it is unit-tested directly.
 */
import {
  BaseError,
  ContractFunctionRevertedError,
  UserRejectedRequestError,
  type Address,
  type Hex,
} from "viem"
import { mainnet } from "viem/chains"
import { fixedPriceMinterAbi, fixedPriceSaleAbi } from "./abi"
import type { SaleState } from "./surface"

/** The only chain this template reads and writes (see lib/rpc.ts). */
export const MINT_CHAIN_ID = mainnet.id

/**
 * The mint call for either sale generation. `to` is the recipient AND the
 * address the sale's gate and wallet cap evaluate; `referrer` is credited the
 * sale's referral share (v2: 5%, fixed; v1: the minter's referralShareBps).
 * `value` must be the sale's own `priceOf(to, quantity)` read at mint time
 * (lib/surface-reads.ts `quoteMint`): both sales require exact payment for a
 * fixed price.
 */
export function buildMintRequest({
  sale,
  to,
  quantity,
  referrer,
  value,
  data = "0x",
}: {
  sale: Pick<SaleState, "kind" | "address">
  to: Address
  quantity: bigint
  referrer: Address
  value: bigint
  data?: Hex
}) {
  if (sale.kind === "v2-fixed-price") {
    return {
      chainId: MINT_CHAIN_ID,
      address: sale.address,
      abi: fixedPriceSaleAbi,
      functionName: "mintWithReferral" as const,
      args: [to, quantity, referrer, data] as const,
      value,
    }
  }
  return {
    chainId: MINT_CHAIN_ID,
    address: sale.address,
    abi: fixedPriceMinterAbi,
    functionName: "mint" as const,
    args: [to, quantity, referrer, data] as const,
    value,
  }
}

/** Collector-facing copy for every revert the mint path can hit, keyed by
 *  the custom error's name (sale errors from both generations, plus the
 *  token's own mintTo errors that bubble up through the sale). */
const REVERT_COPY: Record<string, string> = {
  SaleClosed: "This sale is closed.",
  MintNotStarted: "The mint has not opened yet.",
  MintEnded: "The mint window has ended.",
  MaxMintsExceeded: "Not enough left in this sale for that quantity.",
  ExceedsCap: "Not enough supply left for that quantity.",
  GateRejected: "This wallet is not eligible for this mint.",
  NotAllowlisted: "This wallet is not on the allowlist.",
  WalletCapExceeded: "That quantity would pass this wallet's mint limit.",
  WrongPayment: "The price changed. Refresh and try again.",
  Underpayment: "The price changed. Refresh and try again.",
  ReceiverRejected: "The receiving wallet cannot accept NFTs.",
  ZeroQuantity: "Choose a quantity of at least 1.",
  NotMinter: "This sale is no longer the collection's minter.",
}

/**
 * The first line a collector should see for a failed simulate or send.
 * Walks viem's cause chain for a decoded custom revert, then a wallet
 * rejection, then falls back to viem's own short message.
 */
export function describeMintError(error: unknown): string {
  if (error instanceof BaseError) {
    const reverted = error.walk((e) => e instanceof ContractFunctionRevertedError)
    if (reverted instanceof ContractFunctionRevertedError) {
      const name = reverted.data?.errorName
      if (name && REVERT_COPY[name]) return REVERT_COPY[name]
      if (name) return `The mint reverted (${name}).`
      if (reverted.reason) return `The mint reverted: ${reverted.reason}`
    }
    if (error.walk((e) => e instanceof UserRejectedRequestError)) {
      return "Transaction cancelled in the wallet."
    }
    const lower = error.message.toLowerCase()
    if (lower.includes("insufficient funds")) {
      return "Not enough ETH for the price plus gas."
    }
    return error.shortMessage || "Transaction failed."
  }
  if (error instanceof Error) return error.message.split("\n")[0] || "Transaction failed."
  return "Transaction failed."
}
