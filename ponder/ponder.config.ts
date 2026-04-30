import { createConfig, factory } from "ponder"
import { http, parseAbiItem } from "viem"
import { sovereignAuctionHouseAbi } from "./abis/SovereignAuctionHouse"
import { sovereignAuctionHouseFactoryAbi } from "./abis/SovereignAuctionHouseFactory"
import { nftMarketAbi } from "./abis/NFTMarket"
import { foundationNftAbi, collectionFactoryAbi } from "./abis/FoundationNft"
import { erc721Abi } from "./abis/Erc721"

// Production address of the SovereignAuctionHouseFactory on mainnet. Pinned
// here rather than imported from @pin/addresses so this directory can deploy
// independently to Railway without dragging in the full monorepo.
const FACTORY_ADDRESS = "0xaE712abcA452901A74D1FBC0c3919F2cc060EF9f" as const

// Factory deploy block — verified: `cast code` returns 0x at 24,973,293
// and real bytecode at 24,973,294. No clones can exist before this block.
const FACTORY_DEPLOY_BLOCK = 24_973_294

// Foundation NFTMarket proxy. Single shared marketplace contract; deploy
// block matches what the web app uses as `FND_MARKET_DEPLOY_BLOCK`. Indexing
// from here forward gives us full historical Foundation auction + buy-now +
// sale data so last-sale, bid-history, and seller-listings reads can hit
// Postgres instead of doing 10M-block `eth_getLogs` against Alchemy.
const NFT_MARKET_ADDRESS =
  "0xcDA72070E455bb31C7690a170224Ce43623d0B6f" as const
const NFT_MARKET_DEPLOY_BLOCK = 13_840_000

// Foundation shared 1/1 NFT contract — emits Minted(creator, tokenId) for
// every artist mint on the legacy shared contract.
const FOUNDATION_NFT_ADDRESS =
  "0x3B3ee1931Dc30C1957379FAc9aba94D1C48a5405" as const
const FOUNDATION_NFT_DEPLOY_BLOCK = 11_907_800

// Foundation NFTCollectionFactory V1 + V2. V1 was renamed mid-deploy so
// it emits both `CollectionCreated` (legacy) and `NFTCollectionCreated`
// (modern); V2 emits the modern name plus `NFTDropCollectionCreated` for
// drop collections. We track each as its own contract entry so handler
// names stay namespaced (FoundationCollectionFactoryV1:NFTCollectionCreated
// vs V2:…).
const COLLECTION_FACTORY_V1_ADDRESS =
  "0x3B612a5B49e025a6e4bA4eE4FB1EF46D13588059" as const
const COLLECTION_FACTORY_V1_DEPLOY_BLOCK = 14_000_000

const COLLECTION_FACTORY_V2_ADDRESS =
  "0x612E2DadDc89d91409e40f946f9f7CfE422e777E" as const
const COLLECTION_FACTORY_V2_DEPLOY_BLOCK = 15_000_000

// Ponder needs a direct RPC URL for sync (heavy `eth_getLogs`). Don't point
// this at the app's `/api/rpc` proxy — the allowlist there blocks the
// patterns Ponder needs, and the rate limit would fight initial sync. Set
// PONDER_RPC_URL_1 directly on the Railway Ponder service to a non-public
// Alchemy URL.
const RPC_URL = process.env.PONDER_RPC_URL_1 ?? "https://eth.llamarpc.com"

export default createConfig({
  chains: {
    mainnet: {
      id: 1,
      rpc: http(RPC_URL),
      pollingInterval: 5_000,
    },
  },
  contracts: {
    // Factory itself: tells us when new houses get deployed.
    SovereignAuctionHouseFactory: {
      chain: "mainnet",
      abi: sovereignAuctionHouseFactoryAbi,
      address: FACTORY_ADDRESS,
      startBlock: FACTORY_DEPLOY_BLOCK,
    },
    // Every clone the factory has emitted, indexed automatically. Ponder
    // streams `AuctionHouseCreated` events from the factory, then starts
    // tracking each clone's auction events from its own deploy block.
    SovereignAuctionHouse: {
      chain: "mainnet",
      abi: sovereignAuctionHouseAbi,
      address: factory({
        address: FACTORY_ADDRESS,
        event: parseAbiItem(
          "event AuctionHouseCreated(address indexed owner, address indexed house, address feeRecipient, uint16 protocolFeeBps)",
        ),
        parameter: "house",
      }),
      startBlock: FACTORY_DEPLOY_BLOCK,
    },
    // Foundation NFTMarket — fixed address, full history backfill from Dec
    // 2021. Initial sync is the slow part (~10M blocks); steady-state polling
    // is cheap because event volume is low (Foundation is largely
    // deprecated). Pays for itself on the first cache miss it absorbs.
    NFTMarket: {
      chain: "mainnet",
      abi: nftMarketAbi,
      address: NFT_MARKET_ADDRESS,
      startBlock: NFT_MARKET_DEPLOY_BLOCK,
    },
    // Foundation shared 1/1 NFT contract — Minted events power per-artist
    // shared-contract token discovery (replaces the eth_getLogs scan in
    // discoverSharedContractRefs).
    FoundationNFT: {
      chain: "mainnet",
      abi: foundationNftAbi,
      address: FOUNDATION_NFT_ADDRESS,
      startBlock: FOUNDATION_NFT_DEPLOY_BLOCK,
    },
    // V1 + V2 NFTCollectionFactory: tracks every per-artist Foundation
    // collection contract deployed.
    FoundationCollectionFactoryV1: {
      chain: "mainnet",
      abi: collectionFactoryAbi,
      address: COLLECTION_FACTORY_V1_ADDRESS,
      startBlock: COLLECTION_FACTORY_V1_DEPLOY_BLOCK,
    },
    FoundationCollectionFactoryV2: {
      chain: "mainnet",
      abi: collectionFactoryAbi,
      address: COLLECTION_FACTORY_V2_ADDRESS,
      startBlock: COLLECTION_FACTORY_V2_DEPLOY_BLOCK,
    },
    // Every per-artist collection contract emitted by either factory.
    // Indexed for ERC-721 Transfer events; we only persist mints
    // (from = 0x0) into fnd_artist_tokens — transfers between holders
    // aren't needed by any read path yet.
    //
    // Three entries because Ponder's `factory.event` is a single AbiEvent,
    // not an array, and Foundation's factories emit three different
    // create events (modern rename + legacy pre-rename + drop variant).
    // Each entry runs the same Transfer handler since the address comes
    // from `event.log.address` and writes are idempotent
    // (`onConflictDoNothing` on the same primary key).
    FoundationCollectionViaModern: {
      chain: "mainnet",
      abi: erc721Abi,
      address: factory({
        address: [
          COLLECTION_FACTORY_V1_ADDRESS,
          COLLECTION_FACTORY_V2_ADDRESS,
        ],
        event: parseAbiItem(
          "event NFTCollectionCreated(address indexed collection, address indexed creator, uint256 indexed version, string name, string symbol, uint256 nonce)",
        ),
        parameter: "collection",
      }),
      startBlock: COLLECTION_FACTORY_V1_DEPLOY_BLOCK,
    },
    FoundationCollectionViaLegacy: {
      chain: "mainnet",
      abi: erc721Abi,
      address: factory({
        address: [
          COLLECTION_FACTORY_V1_ADDRESS,
          COLLECTION_FACTORY_V2_ADDRESS,
        ],
        event: parseAbiItem(
          "event CollectionCreated(address indexed collection, address indexed creator, uint256 indexed version, string name, string symbol, uint256 nonce)",
        ),
        parameter: "collection",
      }),
      startBlock: COLLECTION_FACTORY_V1_DEPLOY_BLOCK,
    },
    FoundationCollectionViaDrop: {
      chain: "mainnet",
      abi: erc721Abi,
      address: factory({
        address: [
          COLLECTION_FACTORY_V1_ADDRESS,
          COLLECTION_FACTORY_V2_ADDRESS,
        ],
        event: parseAbiItem(
          "event NFTDropCollectionCreated(address indexed collection, address indexed creator, address indexed approvedMinter, string name, string symbol, string baseURI, bool isRevealed, uint256 maxTokenId, address paymentAddress, uint256 version, uint256 nonce)",
        ),
        parameter: "collection",
      }),
      startBlock: COLLECTION_FACTORY_V1_DEPLOY_BLOCK,
    },
  },
})
