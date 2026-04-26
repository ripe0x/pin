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

// PND auction house factory (deploys per-artist BeaconProxy auction houses).
// TODO: replace with real address after the mainnet deploy lands.
export const PND_AUCTION_HOUSE_FACTORY: Record<number, Address> = {
  [MAINNET_CHAIN_ID]: "0x0000000000000000000000000000000000000000",
  [BASE_CHAIN_ID]: "0x0000000000000000000000000000000000000000",
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
