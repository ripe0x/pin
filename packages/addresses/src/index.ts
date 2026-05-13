import { type Address } from "viem"

/**
 * Foundation contract addresses per chain.
 *
 * Mainnet addresses are verified on Etherscan.
 * Base addresses are TBD — see spike #1 in the plan.
 */

export const MAINNET_CHAIN_ID = 1 as const
export const BASE_CHAIN_ID = 8453 as const

export type SupportedChainId = typeof MAINNET_CHAIN_ID | typeof BASE_CHAIN_ID

// NFTMarket proxy (all marketplace actions — auctions, buy-now, offers)
export const NFT_MARKET: Record<SupportedChainId, Address> = {
  [MAINNET_CHAIN_ID]: "0xcDA72070E455bb31C7690a170224Ce43623d0B6f",
  [BASE_CHAIN_ID]: "0x0000000000000000000000000000000000000000", // TODO: confirm on Basescan
}

// Foundation shared 1/1 NFT contract
export const FOUNDATION_NFT: Record<number, Address> = {
  [MAINNET_CHAIN_ID]: "0x3B3ee1931Dc30C1957379FAc9aba94D1C48a5405",
}

// FETH (Foundation ETH — wrapped escrow for bids)
export const FETH: Record<number, Address> = {
  [MAINNET_CHAIN_ID]: "0x49128CF8ABe9071ee24540a296b5DED3F9D50443",
  [BASE_CHAIN_ID]: "0x0000000000000000000000000000000000000000", // TODO: confirm
}

// Collection factory V1 (creator-deployed collections)
export const COLLECTION_FACTORY_V1: Record<number, Address> = {
  [MAINNET_CHAIN_ID]: "0x3B612a5B49e025a6e4bA4eE4FB1EF46D13588059",
}

// Collection factory V2 (creator-deployed collections, drops, editions)
export const COLLECTION_FACTORY_V2: Record<number, Address> = {
  [MAINNET_CHAIN_ID]: "0x612E2DadDc89d91409e40f946f9f7CfE422e777E",
}

// SuperRare V2 NFT (ERC-721). Deployed 2019-08; powers most non-Spaces
// SuperRare 1/1s. Used for: artist gallery discovery (Transfer-from-zero
// scan), collector-page ownership snapshots.
export const SUPERRARE_V2_NFT: Record<number, Address> = {
  [MAINNET_CHAIN_ID]: "0xb932a70A57673d89f4acfFBE830E8ed7f75Fb9e0",
}

// SuperRare Bazaar (unified marketplace: auctions + offers + buy-now).
// All bids/settlements/cancellations on V2 tokens flow through this
// contract. The contract enforces SR's marketplace fee internally — our
// UI just submits txs. Used for: last-sale (AuctionSettled events),
// active-auction state (tokenAuctions mapping), home-grid active scan.
export const SUPERRARE_BAZAAR: Record<number, Address> = {
  [MAINNET_CHAIN_ID]: "0x6d7c44773c52d396f43c2d511b81aa168e9a7a42",
}

// Transient Labs Auction House (v2.6.1). Marketplace contract handling
// bids / settle / cancel on auctions and buy-now flows for any ERC-721
// (typically TL's `ERC721TL` per-artist proxies, but works on any
// 721 the seller has approved). Custodies the NFT during an active
// listing — `ownerOf` returns this address, which is what our token-
// detail-page routing uses to dispatch to the TL adapter.
export const TL_AUCTION_HOUSE: Record<number, Address> = {
  [MAINNET_CHAIN_ID]: "0x6f66b95a0C512f3497FB46660E0BC3B94B989F8d",
}

// Transient Labs Universal Deployer. Factory for ERC721TL / ERC1155TL
// minimal-proxy artist contracts. Same address cross-chain via CREATE2.
// Used (eventually) to enumerate per-artist contracts for the artist
// gallery — not consumed in the initial auction-only PR.
export const TL_UNIVERSAL_DEPLOYER: Record<number, Address> = {
  [MAINNET_CHAIN_ID]: "0x7c24805454F7972d36BEE9D139BD93423AA29f3f",
}

// SovereignAuctionHouseFactory (deploys per-owner EIP-1167 minimal proxies).
// Mainnet deploy: 2026-04-27, fee 0bps, recipient 0x0 (locked forever).
// For local Anvil-fork testing, paste the local factory address here
// temporarily — but RESTORE the mainnet address before committing.
export const SOVEREIGN_AUCTION_HOUSE_FACTORY: Record<number, Address> = {
  [MAINNET_CHAIN_ID]: "0xaE712abcA452901A74D1FBC0c3919F2cc060EF9f",
  [BASE_CHAIN_ID]: "0x0000000000000000000000000000000000000000",
}

// ArtistRecordRegistry — generic public registry where an artist address can
// publish on-chain pointers (contracts, tokens, ranges) belonging to its
// public record. Deployed via the canonical CREATE2 deterministic-deployment
// proxy with salt = keccak256("ArtistRecordRegistry"), so the same source +
// salt yields the same address on every EVM chain we ever deploy to. The
// value below is the predicted address from the CREATE2 computation;
// confirm with `cast code` after the first mainnet deploy.
export const ARTIST_RECORD_REGISTRY: Record<number, Address> = {
  [MAINNET_CHAIN_ID]: "0x3971294346dFeC661a9210B43eEbf71777E686fD",
}

// Helper for the address-or-null pattern: returns null when no factory is
// configured for the chain (instead of throwing like getAddress).
export function getAddressOrNull(
  addresses: Record<number, Address>,
  chainId: number,
): Address | null {
  const addr = addresses[chainId]
  if (!addr || addr === "0x0000000000000000000000000000000000000000") return null
  return addr
}

// Helper to get address or throw
export function getAddress(
  addresses: Record<number, Address>,
  chainId: number
): Address {
  const addr = addresses[chainId]
  if (!addr || addr === "0x0000000000000000000000000000000000000000") {
    throw new Error(`No address configured for chainId ${chainId}`)
  }
  return addr
}
