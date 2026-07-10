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

// Mint protocol (Visualize Value) Factory. Deploys per-artist
// ERC1155 collection contracts (the per-collection `Mint.sol`
// implementation, wrapped by an ERC1967 proxy or minimal-proxy clone).
// Emits `Created(address indexed ownerAddress, address contractAddress)`
// on every collection deploy — `ownerAddress` is the artist, indexed
// for cheap topic-filtered enumeration of an artist's clones.
// Deployed Nov 2024 in tx 0x57b1ad0…46ce650 at block 21167599.
export const MINT_FACTORY: Record<number, Address> = {
  [MAINNET_CHAIN_ID]: "0xd717Fe677072807057B03705227EC3E3b467b670",
}

// SovereignAuctionHouseFactory (deploys per-owner EIP-1167 minimal proxies).
// Mainnet deploy: 2026-04-27, fee 0bps, recipient 0x0 (locked forever).
// For local Anvil-fork testing, paste the local factory address here
// temporarily — but RESTORE the mainnet address before committing.
export const SOVEREIGN_AUCTION_HOUSE_FACTORY: Record<number, Address> = {
  [MAINNET_CHAIN_ID]: "0xaE712abcA452901A74D1FBC0c3919F2cc060EF9f",
  [BASE_CHAIN_ID]: "0x0000000000000000000000000000000000000000",
}

// SUPERSEDED — PND Editions (PNDEditionsFactory + reference mint hooks) is
// retired in favor of the Collection system (see
// SOVEREIGN_COLLECTION_FACTORY + ATTRIBUTION below). The editions contracts
// (contracts/src/editions/*) and DeployEditions.s.sol are deleted; these
// addresses were never deployed to mainnet (still zero) and are kept only as
// harmless history / in case any external reference still points at these
// exported names. Do not wire up new code against these.
//
// PNDEditionsFactory — deployed one ERC721A contract per project (artist
// release). ImmutableClone (EIP-1167) or Upgradeable (ERC1967/UUPS) per the
// ProjectMode chosen at createProject. Emitted
// `ProjectCreated(address indexed owner, address indexed project, uint8 mode)`
// for discovery, mirroring Mint's MintFactory.Created. There was no protocol
// fee.
export const PND_EDITIONS_FACTORY: Record<number, Address> = {
  [MAINNET_CHAIN_ID]: "0x0000000000000000000000000000000000000000",
}

// SUPERSEDED (see note above) — PND reference mint hooks (public goods). One
// shared instance per hook, configured per-edition by each edition's owner;
// an artist opted in by pointing setMintHook at one.
export const PND_PER_WALLET_CAP_HOOK: Record<number, Address> = {
  [MAINNET_CHAIN_ID]: "0x0000000000000000000000000000000000000000",
}
export const PND_ALLOWLIST_HOOK: Record<number, Address> = {
  [MAINNET_CHAIN_ID]: "0x0000000000000000000000000000000000000000",
}
export const PND_HOLDS_EDITION_HOOK: Record<number, Address> = {
  [MAINNET_CHAIN_ID]: "0x0000000000000000000000000000000000000000",
}

// 0xSplits SplitMain (canonical, immutable). Same address across mainnet and
// most L2s via deterministic deploy. Used to deploy an immutable payment split
// (controller = 0) as an edition's payoutAddress when an artist adds
// collaborators, so collaborator funds land in 0xSplits, not the artist's
// upgradeable edition. Verify the address per chain at https://docs.splits.org.
export const SPLIT_MAIN: Record<number, Address> = {
  [MAINNET_CHAIN_ID]: "0x2ed6c4B5dA6378c7897AC67Ba9e43102Feb694EE",
  [BASE_CHAIN_ID]: "0x2ed6c4B5dA6378c7897AC67Ba9e43102Feb694EE",
}

// Catalog — generic public registry where an artist address can
// publish on-chain pointers (contracts, tokens, ranges) belonging to its
// public record. Deployed via the canonical CREATE2 deterministic-deployment
// proxy with salt = keccak256("Catalog"), so the same source +
// salt yields the same address on every EVM chain we ever deploy to. The
// value below is the predicted address from the CREATE2 computation;
// confirm with `cast code` after the first mainnet deploy.
export const ARTIST_RECORD_REGISTRY: Record<number, Address> = {
  [MAINNET_CHAIN_ID]: "0x467a9c39e03C595EC3075D856f19C7386b6b915d",
}

// MURI Protocol singleton — on-chain media-permanence registry (multi-URI
// fallbacks + SHA-256 integrity hash + default on-chain HTML viewer). Same
// vanity address cross-chain (mainnet/Base/Sepolia). Mainnet deploy block
// 23754750 (verified via eth_getCode binary search) — used as the Ponder
// subscription startBlock.
export const MURI_PROTOCOL: Record<number, Address> = {
  [MAINNET_CHAIN_ID]: "0x0000000000C2A0B63ab4aA971B08B905E5875b01",
}

export const MURI_PROTOCOL_START_BLOCK: Record<number, number> = {
  [MAINNET_CHAIN_ID]: 23754750,
}

// MURIProtocolManifoldExtension — the Manifold Creator Extension PND mints
// through. Register it on a Manifold contract (registerExtension) + register
// the contract with MURI (registerContract), then mintERC721/mintERC1155.
// Same address cross-chain.
export const MURI_MANIFOLD_EXTENSION: Record<number, Address> = {
  [MAINNET_CHAIN_ID]: "0x0FFc4A1906157248ae64F28fD259bB7a2790606C",
}

// CollectionFactory — deploys one Collection per work as an
// immutable EIP-1167 clone (no protocol fee; Referral Share is fixed inside the
// collection). NOT yet deployed to mainnet — paste the address here after
// running the collection deploy script. For local Anvil dev, set the
// corresponding NEXT_PUBLIC_* env var instead of editing this file.
export const SOVEREIGN_COLLECTION_FACTORY: Record<number, Address> = {
  [MAINNET_CHAIN_ID]: "0x0000000000000000000000000000000000000000",
}

// Attribution — singleton roster contract for optional collaborator writes at
// collection deploy. NOT yet deployed to mainnet — paste the address here
// after deploy.
export const ATTRIBUTION: Record<number, Address> = {
  [MAINNET_CHAIN_ID]: "0x0000000000000000000000000000000000000000",
}

// RenderAssets — renderer-land registry of static display assets (cover +
// per-token captures), written under each collection's own owner/admin
// authority. NOT yet deployed to mainnet — paste the address here after
// deploy.
export const RENDER_ASSETS: Record<number, Address> = {
  [MAINNET_CHAIN_ID]: "0x0000000000000000000000000000000000000000",
}

// GenerativeRenderer — on-chain renderer for generative-script collections
// (wired into a Collection at deploy or swapped later by the
// owner). NOT yet deployed to mainnet — paste the address here after deploy.
export const GENERATIVE_RENDERER: Record<number, Address> = {
  [MAINNET_CHAIN_ID]: "0x0000000000000000000000000000000000000000",
}

// DefaultRenderer — the canonical built-in renderer every
// CollectionFactory wires into its clones unless the owner swaps it.
// NOT yet deployed to mainnet — paste the address here after deploy.
export const DEFAULT_RENDERER: Record<number, Address> = {
  [MAINNET_CHAIN_ID]: "0x0000000000000000000000000000000000000000",
}

// Scripty V2 Builder — assembles HTML/JS from ScriptyStorage-held chunks at
// render time. Deterministic deploy, same address on mainnet and most other
// EVM chains. See https://github.com/intartnft/scripty.sol.
export const SCRIPTY_BUILDER_V2: Record<number, Address> = {
  [MAINNET_CHAIN_ID]: "0xD7587F110E08F4D120A231bA97d3B577A81Df022",
}

// Scripty V2 Storage — content-addressed chunk storage for on-chain
// scripts (see packages/abi/src/scriptyStorage.ts for the hand-written ABI
// and its source-verification notes). Deterministic deploy, same address on
// mainnet and most other EVM chains.
export const SCRIPTY_STORAGE_V2: Record<number, Address> = {
  [MAINNET_CHAIN_ID]: "0xbD11994aABB55Da86DC246EBB17C1Be0af5b7699",
}

// EthFS V2 File Storage — the underlying file store Scripty V2 Storage
// deploys chunk pointers against. Deterministic deploy, same address on
// mainnet and most other EVM chains.
export const ETHFS_V2_FILE_STORAGE: Record<number, Address> = {
  [MAINNET_CHAIN_ID]: "0x8FAA1AAb9DA8c75917C43Fb24fDdb513edDC3245",
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
