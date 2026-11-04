/**
 * Bid and settle transaction building plus revert decoding for the auction
 * panel. Pure (no React, no server-only), so it is unit-tested directly.
 */
import {
  BaseError,
  ContractFunctionRevertedError,
  UserRejectedRequestError,
  type Address,
} from "viem"
import { sovereignAuctionHouseAbi, sovereignAuctionHouseV2Abi } from "./abi"
import { canBid } from "./auction-policy"
import type { HouseVersion } from "./auction-status"
import { MINT_CHAIN_ID } from "./mint-transaction"

/** The only chain this template reads and writes (see lib/rpc.ts). */
export const AUCTION_CHAIN_ID = MINT_CHAIN_ID

/**
 * A `createBid` call on a V2 house, pinned to mainnet. Returns null for a V1
 * house: bids there are paused (lib/auction-policy.ts), so no code path in
 * the site can build one.
 */
export function buildBidRequest({
  house,
  houseVersion,
  auctionId,
  value,
}: {
  house: Address
  houseVersion: HouseVersion
  auctionId: string | bigint
  value: bigint
}) {
  if (!canBid(houseVersion)) return null
  return {
    chainId: AUCTION_CHAIN_ID,
    address: house,
    abi: sovereignAuctionHouseV2Abi,
    functionName: "createBid" as const,
    args: [BigInt(auctionId)] as const,
    value,
  }
}

/**
 * An `endAuction` call, pinned to mainnet. Settlement works on both house
 * generations: a V1 auction that already has a bid must still settle.
 */
export function buildSettleRequest({
  house,
  houseVersion,
  auctionId,
}: {
  house: Address
  houseVersion: HouseVersion
  auctionId: string | bigint
}) {
  const args = [BigInt(auctionId)] as const
  if (houseVersion === 2) {
    return {
      chainId: AUCTION_CHAIN_ID,
      address: house,
      abi: sovereignAuctionHouseV2Abi,
      functionName: "endAuction" as const,
      args,
    }
  }
  return {
    chainId: AUCTION_CHAIN_ID,
    address: house,
    abi: sovereignAuctionHouseAbi,
    functionName: "endAuction" as const,
    args,
  }
}

/** Bidder-facing copy for the house reverts a bid can hit. */
const REVERT_COPY: Record<string, string> = {
  AuctionDoesNotExist: "This auction no longer exists.",
  AuctionExpired: "This auction has ended.",
  BidBelowReserve: "The bid is below the reserve price.",
  BidBelowMinimum: "Someone bid first. Refresh and raise your bid.",
  BidMustBePositive: "Enter a bid above zero.",
  AuctionHasNoBids: "This auction has no bids to settle.",
  AuctionNotEnded: "This auction has not ended yet.",
  AuctionAlreadySettled: "This auction is already settled.",
}

/**
 * The first line a bidder should see for a failed simulate or send. Walks
 * viem's cause chain for a decoded custom revert, then a wallet rejection,
 * then falls back to viem's own short message.
 */
export function describeBidError(error: unknown): string {
  if (error instanceof BaseError) {
    const reverted = error.walk((e) => e instanceof ContractFunctionRevertedError)
    if (reverted instanceof ContractFunctionRevertedError) {
      const name = reverted.data?.errorName
      if (name && REVERT_COPY[name]) return REVERT_COPY[name]
      if (name) return `The transaction reverted (${name}).`
      if (reverted.reason) return `The transaction reverted: ${reverted.reason}`
    }
    if (error.walk((e) => e instanceof UserRejectedRequestError)) {
      return "Transaction cancelled in the wallet."
    }
    const lower = error.message.toLowerCase()
    if (lower.includes("insufficient funds")) {
      return "Not enough ETH for the bid plus gas."
    }
    return error.shortMessage || "Transaction failed."
  }
  if (error instanceof Error) return error.message.split("\n")[0] || "Transaction failed."
  return "Transaction failed."
}
