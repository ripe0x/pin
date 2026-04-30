import { createConfig, factory } from "ponder"
import { http, parseAbiItem } from "viem"
import { sovereignAuctionHouseAbi } from "./abis/SovereignAuctionHouse"
import { sovereignAuctionHouseFactoryAbi } from "./abis/SovereignAuctionHouseFactory"
import { nftMarketAbi } from "./abis/NFTMarket"

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
  },
})
