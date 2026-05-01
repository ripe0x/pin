import { createConfig, factory } from "ponder"
import { http, parseAbiItem } from "viem"
import { sovereignAuctionHouseAbi } from "./abis/SovereignAuctionHouse"
import { sovereignAuctionHouseFactoryAbi } from "./abis/SovereignAuctionHouseFactory"
import { superrareBazaarAbi } from "./abis/SuperRareBazaar"
import { transientAuctionHouseAbi } from "./abis/TransientAuctionHouse"

// Production address of the SovereignAuctionHouseFactory on mainnet. Pinned
// here rather than imported from @pin/addresses so this directory can deploy
// independently to Railway without dragging in the full monorepo.
const FACTORY_ADDRESS = "0xaE712abcA452901A74D1FBC0c3919F2cc060EF9f" as const

// Factory deploy block — verified: `cast code` returns 0x at 24,973,293
// and real bytecode at 24,973,294. No clones can exist before this block.
const FACTORY_DEPLOY_BLOCK = 24_973_294

// SuperRare V2 Bazaar (single shared marketplace, deployed Feb 2022).
// Pragmatic start block: ~30 days behind head (2026-04-01 ≈ block
// 24,800,000). The home grid only surfaces *currently active* auctions
// (≤ 28 days out), so anything with an older NewAuction is either
// already settled (events that arrive after start are processed
// correctly) or stuck. Full backfill from block 14.1M would take
// hours; this trims it to minutes without losing surfaceable rows.
const SR_BAZAAR_ADDRESS = "0x6d7c44773c52d396f43c2d511b81aa168e9a7a42" as const
const SR_BAZAAR_START_BLOCK = 24_800_000

// Transient Labs Auction House (v2.6.1, deployed early 2026). Recent
// enough to cover from deploy.
const TL_AUCTION_HOUSE_ADDRESS = "0x6f66b95a0C512f3497FB46660E0BC3B94B989F8d" as const
const TL_AUCTION_HOUSE_START_BLOCK = 24_500_000

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
    // SuperRare V2 Bazaar: a single marketplace contract handling
    // ANY ERC-721. Auctions keyed by (contract, tokenId) — the
    // marketplace never stamps its own auctionId. Replaces the
    // hand-rolled scanner in apps/web/src/lib/platforms/superrareV2-scan.ts.
    SuperRareBazaar: {
      chain: "mainnet",
      abi: superrareBazaarAbi,
      address: SR_BAZAAR_ADDRESS,
      startBlock: SR_BAZAAR_START_BLOCK,
    },
    // Transient Labs Auction House: also a single marketplace, but
    // custodies the NFT during a live listing (unlike SR Bazaar).
    // Listing struct carries seller, currency, reserve, etc. directly
    // in the event so handlers don't need follow-up reads except for
    // the per-token creator backfill. Replaces transient-scan.ts.
    TransientAuctionHouse: {
      chain: "mainnet",
      abi: transientAuctionHouseAbi,
      address: TL_AUCTION_HOUSE_ADDRESS,
      startBlock: TL_AUCTION_HOUSE_START_BLOCK,
    },
  },
})
