import { createConfig } from "@ponder/core"
import { http } from "viem"
import { nftMarketAbi } from "@pin/abi"
import { erc721Abi } from "@pin/abi"

/**
 * Foundation Indexer — Ponder Configuration
 *
 * v0: only indexes the last 30 days to get running fast.
 * To do a full historical backfill, change RECENT_START_BLOCK
 * to the contract deploy blocks:
 *   NFTMarket:    13_947_905
 *   FoundationNFT: 11_907_800
 */

// ~7 days ago at 12s/block = ~50,400 blocks
// Current mainnet block is ~24,890,000 (April 2026)
const RECENT_START_BLOCK = 24_840_000

export default createConfig({
  networks: {
    mainnet: {
      chainId: 1,
      transport: http(process.env.PONDER_RPC_URL_1),
    },
    // Uncomment once Base addresses are confirmed (spike #1)
    // base: {
    //   chainId: 8453,
    //   transport: http(process.env.PONDER_RPC_URL_8453),
    // },
  },

  contracts: {
    // The NFTMarket proxy — all marketplace events
    NFTMarket: {
      network: "mainnet",
      abi: nftMarketAbi,
      address: "0xcDA72070E455bb31C7690a170224Ce43623d0B6f",
      startBlock: RECENT_START_BLOCK,
    },

    // Foundation's shared 1/1 NFT contract — Transfer events
    FoundationNFT: {
      network: "mainnet",
      abi: erc721Abi,
      address: "0x3B3ee1931Dc30C1957379FAc9aba94D1C48a5405",
      startBlock: RECENT_START_BLOCK,
    },

    // TODO: Add factory-discovered collections via Ponder factory() pattern
    // once CollectionFactory / DropFactory addresses are confirmed.
    //
    // Example:
    // CollectionFactory: {
    //   network: "mainnet",
    //   abi: collectionFactoryAbi,
    //   address: "0x...",
    //   startBlock: ...,
    // },
    // CreatorCollections: {
    //   network: "mainnet",
    //   abi: erc721Abi,
    //   factory: {
    //     address: "0x...",
    //     event: "CollectionCreated(address collection, address creator, ...)",
    //     parameter: "collection",
    //   },
    //   startBlock: ...,
    // },
  },
})
