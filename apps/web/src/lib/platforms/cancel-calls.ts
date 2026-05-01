/**
 * Client-safe cancel-call dispatcher. Given a platform-tagged listing,
 * returns the wagmi-shaped contract call (`{ address, abi, functionName,
 * args, value? }`) used to cancel that listing on its source marketplace.
 *
 * Intentionally not on the `PlatformAdapter` interface: adapters live in
 * `server-only` modules (RPC + DB), but cancel calls execute in the
 * browser via wagmi. Keeping the dispatch here lets the client import a
 * single switch and avoids dragging server-only code into the bundle.
 *
 * Adding a new platform to the migrate / bulk-delist flow is one new
 * `case` here, mirroring the new entry on `PlatformId`.
 */

import { encodeFunctionData, type Abi, type Address } from "viem"
import { nftMarketAbi, superrareBazaarAbi, transientAuctionHouseAbi } from "@pin/abi"
import {
  NFT_MARKET,
  SUPERRARE_BAZAAR,
  TL_AUCTION_HOUSE,
  MAINNET_CHAIN_ID,
} from "@pin/addresses"
import type { SellerListing } from "@/lib/seller-listings"

export type CancelCall = {
  address: Address
  abi: Abi
  functionName: string
  args: readonly unknown[]
  value?: bigint
}

export function buildCancelCall(listing: SellerListing): CancelCall {
  switch (listing.platform) {
    case "foundation":
      if (listing.kind === "auction") {
        return {
          address: NFT_MARKET[MAINNET_CHAIN_ID],
          abi: nftMarketAbi as Abi,
          functionName: "cancelReserveAuction",
          args: [BigInt(listing.auctionId)],
        }
      }
      return {
        address: NFT_MARKET[MAINNET_CHAIN_ID],
        abi: nftMarketAbi as Abi,
        functionName: "cancelBuyPrice",
        args: [listing.nftContract, BigInt(listing.tokenId)],
      }

    case "superrareV2":
      // SR Bazaar cancels by (originContract, tokenId). The migrate flow
      // surfaces auctions only — SR's `salePrice` (buy-now) listings
      // aren't part of the cancellable listings discovery.
      return {
        address: SUPERRARE_BAZAAR[MAINNET_CHAIN_ID],
        abi: superrareBazaarAbi as Abi,
        functionName: "cancelAuction",
        args: [listing.nftContract, BigInt(listing.tokenId)],
      }

    case "transient":
      // TL exposes the cancel-listing call as `delist` (covers both
      // auctions and buy-nows on the same Auction House contract).
      return {
        address: TL_AUCTION_HOUSE[MAINNET_CHAIN_ID],
        abi: transientAuctionHouseAbi as Abi,
        functionName: "delist",
        args: [listing.nftContract, BigInt(listing.tokenId)],
      }

    case "manifold":
    case "sovereign":
      // Sovereign auctions are the destination, not a source we cancel
      // from in this flow. Manifold has no marketplace concept. Both
      // shouldn't appear in cancellable listings — defensive throw.
      throw new Error(
        `buildCancelCall: platform ${listing.platform} is not a cancel source`,
      )
  }
}

/**
 * Encoded `(to, data, value)` form for EIP-5792 batched mode. wagmi's
 * `sendCalls` takes an array of these for one-signature multi-cancels.
 */
export function encodeCancelCallToData(listing: SellerListing): {
  to: Address
  data: `0x${string}`
  value?: bigint
} {
  const call = buildCancelCall(listing)
  return {
    to: call.address,
    data: encodeFunctionData({
      abi: call.abi,
      functionName: call.functionName,
      args: call.args,
    }),
    value: call.value,
  }
}
