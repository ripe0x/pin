import { createConfig, factory } from "ponder"
import { http, parseAbiItem } from "viem"
import { sovereignAuctionHouseAbi } from "./abis/SovereignAuctionHouse"
import { sovereignAuctionHouseFactoryAbi } from "./abis/SovereignAuctionHouseFactory"
import { foundationNftAbi, collectionFactoryAbi } from "./abis/FoundationNFT"
import { nftMarketAbi } from "./abis/NFTMarket"
import { catalogAbi } from "./abis/Catalog"
import { superrareBazaarAbi } from "./abis/SuperRareBazaar"
import { transientAuctionHouseAbi } from "./abis/TransientAuctionHouse"
import { mintFactoryAbi } from "./abis/MintFactory"
import { tlUniversalDeployerAbi } from "./abis/TLUniversalDeployer"

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

// Catalog — single fixed address (no factory pattern). Deployed via
// CREATE2 deterministic-deployment proxy with the same salt across
// chains, so the same address appears everywhere we deploy. Address
// matches `ARTIST_RECORD_REGISTRY[MAINNET_CHAIN_ID]` in
// `packages/addresses/src/index.ts` — kept in sync manually because
// `ponder/` deploys to Railway independently of the monorepo.
const CATALOG_ADDRESS = "0x467a9c39e03C595EC3075D856f19C7386b6b915d" as const

// Catalog deploy block on mainnet. Source: deploy receipt at
// `contracts/broadcast/DeployCatalog.s.sol/1/run-latest.json` —
// `receipts[0].blockNumber` is `0x17ed9e2`. Pinned because the contract
// emitted zero events when this indexer wiring landed, so backfill is
// near-instant; bumping startBlock later only matters if every existing
// row gets re-emitted (it doesn't — the contract uses idempotent writes).
const CATALOG_DEPLOY_BLOCK = 25_090_530

// Foundation startBlock is aligned with PND's FACTORY_DEPLOY_BLOCK so the
// activity feed shows a consistent ~7-month window across both contract
// families. Foundation contracts have 5+ years of pre-startBlock history;
// per-token / per-artist views still serve that on demand via the lazy
// backfill in apps/web/src/lib/lazy-index.ts. If full-history Foundation
// indexing is needed later, reduce this to 11_907_800 (FoundationNFT
// deploy) and re-sync — same operational cost as a normal Ponder re-sync,
// but tens of thousands of additional getLogs scans during backfill.
const FND_START_BLOCK = FACTORY_DEPLOY_BLOCK

// SuperRare V2 Bazaar (single shared marketplace, deployed Feb 2022).
// Pragmatic start block: the home grid only surfaces *currently active*
// auctions (≤ 28 days out), so anything older is either already settled
// (those events arrive after start and are processed correctly) or
// stuck. Full backfill from block 14.1M would take hours; this trims it
// to minutes without losing surfaceable rows.
const SR_BAZAAR_ADDRESS = "0x6d7c44773c52d396f43c2d511b81aa168e9a7a42" as const
const SR_BAZAAR_START_BLOCK = 24_800_000

// Transient Labs Auction House (v2.6.1, deployed early 2026). Recent
// enough to cover from deploy.
const TL_AUCTION_HOUSE_ADDRESS = "0x6f66b95a0C512f3497FB46660E0BC3B94B989F8d" as const
const TL_AUCTION_HOUSE_START_BLOCK = 24_500_000

// Mint protocol (Visualize Value) Factory. Deploys per-artist
// ERC-1155 collection contracts (the per-collection `Mint.sol`
// implementation, wrapped by an ERC1967 proxy or minimal-proxy clone).
// Emits `Created(address indexed ownerAddress, address contractAddress)`
// on every collection deploy — `ownerAddress` is the artist, indexed
// for cheap topic-filtered enumeration of an artist's clones.
// Deployed Nov 2024 in tx 0x57b1ad0…46ce650 at block 21167599.
//
// Pinned here rather than imported from @pin/addresses for the same
// independent-deploy reason as the other addresses above.
const MINT_FACTORY_ADDRESS = "0xd717Fe677072807057B03705227EC3E3b467b670" as const
const MINT_FACTORY_DEPLOY_BLOCK = 21_167_599

// Transient Labs Universal Deployer (factory for ERC721TL / ERC1155TL
// minimal-proxy clones). Same address cross-chain via CREATE2.
// Deployed at block 19_062_900 (Jan 22, 2024). All TL artist contracts
// flow through `ContractDeployed` events from this address.
const TL_DEPLOYER_ADDRESS = "0x7c24805454F7972d36BEE9D139BD93423AA29f3f" as const
const TL_DEPLOYER_DEPLOY_BLOCK = 19_062_900

// Use drpc.org's free tier (`PONDER_RPC_URL_1=https://eth.drpc.org`).
// It handles the factory-pattern multi-address `eth_getLogs` calls that
// Ponder issues (up to 50 cloned addresses per request, hardcoded slice
// in `node_modules/ponder/src/sync-historical/index.ts:188`, no config
// knob in v0.16). publicnode, llamarpc, and ankr all reject the
// multi-address shape and a viem.fallback() across them just adds retry
// latency before falling through to whatever paid endpoint serves it.
// Alchemy works but burns CU fast as clone count grows — we hit a
// monthly cap in a single afternoon at 60s polling with 76 clones.
//
// Cost is controlled by `pollingInterval` below. Don't point this at
// the app's `/api/rpc` proxy: the allowlist there blocks the bulk
// getLogs patterns Ponder needs, and the rate limit would fight sync.
const RPC_URL = process.env.PONDER_RPC_URL_1
if (!RPC_URL) {
  throw new Error(
    "PONDER_RPC_URL_1 is required. drpc.org free tier works: " +
      "https://eth.drpc.org",
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

    // ── Catalog ─────────────────────────────────────────────────────────
    // Single fixed-address registry — no factory pattern. Each artist
    // publishes contract/token/range pointers via writes; the six
    // Added/Removed events on the contract are mirrored into the three
    // `catalog_*` tables and the web app reads from those instead of
    // doing a per-render multicall against the chain.
    Catalog: {
      chain: "mainnet",
      abi: catalogAbi,
      address: CATALOG_ADDRESS,
      startBlock: CATALOG_DEPLOY_BLOCK,
    },

    // ── SuperRare V2 Bazaar ────────────────────────────────────────────
    // Single marketplace contract handling ANY ERC-721. Auctions keyed
    // by (contract, tokenId) — the marketplace never stamps its own
    // auctionId. Replaces the hand-rolled scanner in
    // apps/web/src/lib/platforms/superrareV2-scan.ts.
    SuperRareBazaar: {
      chain: "mainnet",
      abi: superrareBazaarAbi,
      address: SR_BAZAAR_ADDRESS,
      startBlock: SR_BAZAAR_START_BLOCK,
    },

    // ── Transient Labs Auction House ───────────────────────────────────
    // Single marketplace contract; custodies the NFT during a live
    // listing (unlike SR Bazaar). Listing struct carries seller,
    // currency, reserve, etc. directly in the event so handlers don't
    // need follow-up reads except for the per-token creator backfill.
    // Replaces transient-scan.ts.
    TransientAuctionHouse: {
      chain: "mainnet",
      abi: transientAuctionHouseAbi,
      address: TL_AUCTION_HOUSE_ADDRESS,
      startBlock: TL_AUCTION_HOUSE_START_BLOCK,
    },

    // ── Mint protocol Factory + per-artist clones ──────────────────────
    // Factory emits `Created(ownerAddress, contractAddress)` on every
    // collection deploy. We index the Created stream to a `mint_creators`
    // table (replaces the public.mint_creators table that fed the
    // known_artists view) and use the dynamic-factory pattern to
    // subscribe to TransferSingle/TransferBatch on each clone for the
    // per-artist token list.
    MintFactory: {
      chain: "mainnet",
      abi: mintFactoryAbi,
      address: MINT_FACTORY_ADDRESS,
      startBlock: MINT_FACTORY_DEPLOY_BLOCK,
    },
    // Per-artist clones spawned by the Factory. ERC-1155 transfers from
    // address(0) are the mint signal — see handlers in src/Mint.ts.
    MintCollection: {
      chain: "mainnet",
      abi: [
        parseAbiItem(
          "event TransferSingle(address indexed operator, address indexed from, address indexed to, uint256 id, uint256 value)",
        ),
        parseAbiItem(
          "event TransferBatch(address indexed operator, address indexed from, address indexed to, uint256[] ids, uint256[] values)",
        ),
      ] as const,
      address: factory({
        address: MINT_FACTORY_ADDRESS,
        event: parseAbiItem(
          "event Created(address indexed ownerAddress, address contractAddress)",
        ),
        parameter: "contractAddress",
      }),
      startBlock: MINT_FACTORY_DEPLOY_BLOCK,
    },

    // ── TL Universal Deployer + per-artist ERC721TL clones ─────────────
    // The Universal Deployer emits `ContractDeployed` on every ERC721TL
    // / ERC1155TL clone deploy; we index ERC-721 clones (filtered in
    // the handler by cType) into `tl_creators` and use the dynamic-
    // factory pattern to subscribe to `Transfer` on each clone for
    // the per-artist token list. ERC-1155 support deferred — matches
    // the prior lazy-scan scope.
    TLUniversalDeployer: {
      chain: "mainnet",
      abi: tlUniversalDeployerAbi,
      address: TL_DEPLOYER_ADDRESS,
      startBlock: TL_DEPLOYER_DEPLOY_BLOCK,
    },
    TLCollection: {
      chain: "mainnet",
      abi: [erc721TransferEvent] as const,
      address: factory({
        address: TL_DEPLOYER_ADDRESS,
        event: parseAbiItem(
          "event ContractDeployed(address indexed sender, address indexed deployedContract, address indexed implementation, string cType, string version)",
        ),
        parameter: "deployedContract",
      }),
      startBlock: TL_DEPLOYER_DEPLOY_BLOCK,
    },
  },
})
