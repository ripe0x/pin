import { createConfig, factory } from "ponder"
import { http, parseAbiItem } from "viem"
import { sovereignAuctionHouseAbi } from "./abis/SovereignAuctionHouse"
import { sovereignAuctionHouseFactoryAbi } from "./abis/SovereignAuctionHouseFactory"
import { foundationNftAbi, collectionFactoryAbi } from "./abis/FoundationNFT"
import { nftMarketAbi } from "./abis/NFTMarket"

// Production address of the SovereignAuctionHouseFactory on mainnet. Pinned
// here rather than imported from @pin/addresses so this directory can deploy
// independently to Railway without dragging in the full monorepo.
const FACTORY_ADDRESS = "0xaE712abcA452901A74D1FBC0c3919F2cc060EF9f" as const

// Factory deploy block — verified: `cast code` returns 0x at 24,973,293
// and real bytecode at 24,973,294. No clones can exist before this block.
const FACTORY_DEPLOY_BLOCK = 24_973_294

// Foundation contract addresses (mainnet). Pinned here for the same
// independent-deploy reason as FACTORY_ADDRESS above.
const FOUNDATION_NFT_ADDRESS =
  "0x3B3ee1931Dc30C1957379FAc9aba94D1C48a5405" as const
const NFT_MARKET_ADDRESS =
  "0xcDA72070E455bb31C7690a170224Ce43623d0B6f" as const
const NFT_COLLECTION_FACTORY_V1_ADDRESS =
  "0x3B612a5B49e025a6e4bA4eE4FB1EF46D13588059" as const
const NFT_COLLECTION_FACTORY_V2_ADDRESS =
  "0x612E2DadDc89d91409e40f946f9f7CfE422e777E" as const

// Foundation startBlock is aligned with PND's FACTORY_DEPLOY_BLOCK so the
// activity feed shows a consistent ~7-month window across both contract
// families. Foundation contracts have 5+ years of pre-startBlock history;
// per-token / per-artist views still serve that on demand via the lazy
// backfill in apps/web/src/lib/lazy-index.ts. If full-history Foundation
// indexing is needed later, reduce this to 11_907_800 (FoundationNFT
// deploy) and re-sync — same operational cost as a normal Ponder re-sync,
// but tens of thousands of additional getLogs scans during backfill.
const FND_START_BLOCK = FACTORY_DEPLOY_BLOCK

// Ponder needs a paid RPC URL — Alchemy / Quicknode / drpc / etc. — and
// PONDER_RPC_URL_1 must be set on Railway. We tried fronting it with a
// fallback chain of free public RPCs (publicnode, llamarpc, ankr) and it
// did not work: Ponder's factory pattern issues `eth_getLogs` calls with
// up to 50 cloned addresses bundled in `address` (hardcoded slice in
// `node_modules/ponder/src/sync-historical/index.ts:188`), and every
// free provider we tested rejects multi-address arrays of that size. The
// fallback chain just added retry latency before falling through to the
// paid endpoint anyway.
//
// Cost is controlled instead by `pollingInterval` below — see that
// comment for the math. Don't point this at the app's `/api/rpc` proxy:
// the allowlist there blocks the bulk-getLogs patterns Ponder needs, and
// the rate limit would fight initial sync.
const RPC_URL = process.env.PONDER_RPC_URL_1
if (!RPC_URL) {
  throw new Error(
    "PONDER_RPC_URL_1 is required (paid endpoint: Alchemy / Quicknode / drpc).",
  )
}

// ERC-721 Transfer event — used to track mints (from address zero) on
// every per-artist Foundation collection contract via the factory pattern.
const erc721TransferEvent = parseAbiItem(
  "event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)",
)

export default createConfig({
  chains: {
    mainnet: {
      id: 1,
      rpc: http(RPC_URL),
      // Head-following cadence. Bumped from 60s → 300s (5 min) for cost
      // control: per-poll work scales with the contract surface area
      // (5 base contracts + ~50 cloned auction houses + N FoundationCollection
      // clones, each generating an `eth_getLogs` per tracked event), so
      // dropping poll frequency 5× drops steady-state RPC spend ~5×.
      // Auction state tolerates this: bid lists may show new bids up to
      // 5 min late, but the bid button reads fresh on-chain state at
      // click-time and the contract rejects stale bids regardless of UI
      // freshness. Default is 5s — 300s is 60× cheaper than that baseline.
      pollingInterval: 300_000,
    },
  },
  contracts: {
    // ── PND (Sovereign Auction House) ───────────────────────────────────
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

    // ── Foundation NFTMarket + shared 1/1 ───────────────────────────────
    // Foundation's shared 1/1 NFT contract. We track Mint events here
    // (artist + tokenId + IPFS path) for the activity-feed `mint` events
    // and the `fnd_artist_tokens` index used by the per-artist gallery
    // pre-filter.
    FoundationNFT: {
      chain: "mainnet",
      abi: foundationNftAbi,
      address: FOUNDATION_NFT_ADDRESS,
      startBlock: FND_START_BLOCK,
    },
    // The shared marketplace contract. Powers all FND auction lifecycle
    // events (created, bid, finalized, canceled) plus buy-now (priceSet,
    // accepted, canceled) — which together feed `fnd_auctions`,
    // `fnd_bids`, `fnd_buy_nows`, and `fnd_sales`.
    NFTMarket: {
      chain: "mainnet",
      abi: nftMarketAbi,
      address: NFT_MARKET_ADDRESS,
      startBlock: FND_START_BLOCK,
    },

    // ── Per-artist Foundation collection contracts ──────────────────────
    // Two factories deployed Foundation collection clones (V2 superseded
    // V1 mid-2022 but V1 collections are still live). Each factory emits
    // `NFTCollectionCreated` (and the legacy V1-only `CollectionCreated`)
    // when an artist deploys their own contract. Factory-pattern: every
    // emitted clone is added to the indexer's tracked address set, and
    // ERC-721 Transfer-from-zero events on those clones become mints in
    // `fnd_artist_tokens`.
    NFTCollectionFactoryV1: {
      chain: "mainnet",
      abi: collectionFactoryAbi,
      address: NFT_COLLECTION_FACTORY_V1_ADDRESS,
      startBlock: FND_START_BLOCK,
    },
    NFTCollectionFactoryV2: {
      chain: "mainnet",
      abi: collectionFactoryAbi,
      address: NFT_COLLECTION_FACTORY_V2_ADDRESS,
      startBlock: FND_START_BLOCK,
    },
    // The clones spawned by either factory. Standard ERC-721, but the
    // only event we care about is Transfer (to detect mints). Factory
    // pattern subscribes to all 3 collection-creation event variants
    // because the V1 factory historically emitted both `CollectionCreated`
    // (legacy) and `NFTCollectionCreated` (renamed) and the V2 factory
    // also emits `NFTDropCollectionCreated` for drop-style collections.
    FoundationCollection: {
      chain: "mainnet",
      abi: [erc721TransferEvent] as const,
      address: factory({
        address: [
          NFT_COLLECTION_FACTORY_V1_ADDRESS,
          NFT_COLLECTION_FACTORY_V2_ADDRESS,
        ],
        event: parseAbiItem(
          "event NFTCollectionCreated(address indexed collection, address indexed creator, uint256 indexed version, string name, string symbol, uint256 nonce)",
        ),
        parameter: "collection",
      }),
      startBlock: FND_START_BLOCK,
    },
  },
})
