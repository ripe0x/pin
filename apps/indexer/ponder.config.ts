import { createConfig, factory } from "ponder"
import { http, parseAbiItem } from "viem"
import { sovereignAuctionHouseAbi } from "./abis/SovereignAuctionHouse"
import { sovereignAuctionHouseFactoryAbi } from "./abis/SovereignAuctionHouseFactory"
import { foundationNftAbi, nftCollectionFactoryAbi } from "./abis/FoundationNFT"
import { nftMarketAbi } from "./abis/NFTMarket"
import { catalogAbi } from "./abis/Catalog"
import { mintFactoryAbi } from "./abis/MintFactory"
import { tlUniversalDeployerAbi } from "./abis/TLUniversalDeployer"
import { superrareNftAbi } from "./abis/SuperRareNFT"
import { muriProtocolAbi } from "./abis/MURIProtocol"
import { surfaceAbi } from "./abis/Surface"
import { surfaceFactoryAbi } from "./abis/SurfaceFactory"

/**
 * PND v2 Ponder scope — REDUCED from v1.
 *
 * Indexed (state-machine):
 *   - SovereignAuctionHouseFactory + every clone (PND product)
 *   - NFTMarket (Foundation marketplace — legacy weight)
 *   - FoundationNFT shared 1/1 contract
 *   - SuperRareNFT shared 1/1 contract
 *   - Catalog
 *   - SurfaceFactory + every clone (PND Surface System —
 *     DEPLOY-GATED, see the sentinel + conditional spread below; absent
 *     from `contracts` entirely until the factory is deployed)
 *
 * Discovery-only (one row per artist-deploys-a-clone, NO per-clone events):
 *   - NFTCollectionFactoryV1 + V2 → fnd_collections
 *   - MintFactory → mint_creators
 *   - TLUniversalDeployer → tl_creators
 *
 * DROPPED from v1 (now handled by worker scanners):
 *   - SuperRareBazaar marketplace
 *   - TransientAuctionHouse marketplace
 *   - FoundationCollection per-clone Transfer subscription
 *   - MintCollection per-clone TransferSingle/Batch subscription
 *   - TLCollection per-clone Transfer subscription
 *
 * The "factory()" pattern is used by PND-owned factories (SovereignAuction
 * House, Surface). All other per-clone scanning happens in
 * apps/worker/, gated by `known_artists`. This eliminates the multi-address
 * eth_getLogs work that drove most of v1's Ponder RPC cost.
 */

const FACTORY_ADDRESS = "0xaE712abcA452901A74D1FBC0c3919F2cc060EF9f" as const
const FACTORY_DEPLOY_BLOCK = 24_973_294

const FOUNDATION_NFT_ADDRESS =
  "0x3B3ee1931Dc30C1957379FAc9aba94D1C48a5405" as const
const NFT_MARKET_ADDRESS =
  "0xcDA72070E455bb31C7690a170224Ce43623d0B6f" as const
const NFT_COLLECTION_FACTORY_V1_ADDRESS =
  "0x3B612a5B49e025a6e4bA4eE4FB1EF46D13588059" as const
const NFT_COLLECTION_FACTORY_V2_ADDRESS =
  "0x612E2DadDc89d91409e40f946f9f7CfE422e777E" as const

const CATALOG_ADDRESS = "0x467a9c39e03C595EC3075D856f19C7386b6b915d" as const
const CATALOG_DEPLOY_BLOCK = 25_090_530

// FND startBlock aligned with PND factory deploy so the activity feed
// shows a consistent ~7-month window across both contract families.
const FND_START_BLOCK = FACTORY_DEPLOY_BLOCK

// SuperRare V2 shared 1/1 NFT contract (deployed 2019). Block 8_000_000
// is a safe lower bound; bounded by ~10K total mints ever.
const SR_V2_NFT_ADDRESS = "0xb932a70a57673d89f4acffbe830e8ed7f75fb9e0" as const
const SR_V2_NFT_DEPLOY_BLOCK = 8_000_000

// Mint Factory (Visualize Value). Discovery-only in v2.
const MINT_FACTORY_ADDRESS = "0xd717Fe677072807057B03705227EC3E3b467b670" as const
const MINT_FACTORY_DEPLOY_BLOCK = 21_167_599

// TL Universal Deployer. Discovery-only in v2.
const TL_DEPLOYER_ADDRESS = "0x7c24805454F7972d36BEE9D139BD93423AA29f3f" as const
const TL_DEPLOYER_DEPLOY_BLOCK = 19_062_900

// MURI Protocol singleton — fixed shared media-permanence registry. Low
// event volume; handlers read getArtwork per data-changing event to keep
// URI counts authoritative. Mainnet deploy block verified via eth_getCode.
const MURI_PROTOCOL_ADDRESS =
  "0x0000000000C2A0B63ab4aA971B08B905E5875b01" as const
const MURI_PROTOCOL_DEPLOY_BLOCK = 23_754_750

// PND Surface System (contracts/src/surface/) — the general
// Surface core (Editions preset + generative + backed/pooled
// forms), deployed via a single SurfaceFactory. Mirrors the
// SovereignAuctionHouse(Factory) pattern above: one fixed factory indexed
// for discovery (SurfaceCreated), and `factory()` for full per-clone
// event indexing of every deployed collection.
//
// NOT yet deployed — sentinel zero address. When the sentinel is unset
// (zero), both SurfaceFactory and Surface are
// EXCLUDED from `contracts` below so the config stays valid pre-deploy.
// At mainnet deploy: set SURFACE_FACTORY_ADDRESS to the real
// factory address and SURFACE_FACTORY_DEPLOY_BLOCK to its
// actual deploy block (do NOT leave the placeholder below — it is not a
// safe lower bound, just a marker).
//
// Typed as a widened `0x${string}` (NOT `as const`) so the sentinel
// equality check below stays valid TypeScript both before AND after the
// real address is substituted in — two different address literals
// compared with `as const` on both sides is a TS2367 compile error
// ("no overlap"), which would otherwise break the moment this constant
// is updated at deploy time.
const ZERO_ADDRESS_SENTINEL: `0x${string}` =
  "0x0000000000000000000000000000000000000000"
const SURFACE_FACTORY_ADDRESS: `0x${string}` =
  ZERO_ADDRESS_SENTINEL
const SURFACE_FACTORY_IS_DEPLOYED =
  SURFACE_FACTORY_ADDRESS !== ZERO_ADDRESS_SENTINEL
// LOUD PLACEHOLDER — set this to the real deploy block the moment the
// factory goes live on mainnet. Left wrong, backfill silently starts at
// block 0 and re-scans the entire chain.
const SURFACE_FACTORY_DEPLOY_BLOCK = 0

// drpc.org free tier handles multi-address eth_getLogs for the PND
// factory pattern. See docs/RPC-strategy.md for why publicnode /
// llamarpc / ankr / Alchemy don't.
const RPC_URL = process.env.PONDER_RPC_URL_1
if (!RPC_URL) {
  throw new Error(
    "PONDER_RPC_URL_1 is required. drpc.org free tier works: " +
      "https://eth.drpc.org",
  )
}

export default createConfig({
  chains: {
    mainnet: {
      id: 1,
      rpc: http(RPC_URL),
      // 300s poll. Per-poll work scales linearly with the indexed-
      // contract surface; v2's smaller surface means we could go
      // tighter (60s) without bill impact, but auction-state freshness
      // beyond 5min isn't a product requirement here.
      pollingInterval: 300_000,
      // drpc free tier caps eth_getLogs at 10K blocks per request and
      // throttles at ~100 RPS. Hard limit, not soft throttle — requests
      // over 10K return error code 35. Ponder auto-chunks on errors so
      // backfill still completes; setting maxRequestsPerSecond keeps
      // us comfortably under the rate limit so the auto-chunk loop
      // doesn't burn cycles on retries. Steady-state head-following
      // polls are tiny (<100 blocks per call) and unaffected.
      maxRequestsPerSecond: 25,
    },
  },
  contracts: {
    // ── PND (Sovereign Auction House) — state-machine ─────────────────
    SovereignAuctionHouseFactory: {
      chain: "mainnet",
      abi: sovereignAuctionHouseFactoryAbi,
      address: FACTORY_ADDRESS,
      startBlock: FACTORY_DEPLOY_BLOCK,
    },
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

    // ── Foundation NFTMarket + shared 1/1 ─────────────────────────────
    FoundationNFT: {
      chain: "mainnet",
      abi: foundationNftAbi,
      address: FOUNDATION_NFT_ADDRESS,
      startBlock: FND_START_BLOCK,
    },
    NFTMarket: {
      chain: "mainnet",
      abi: nftMarketAbi,
      address: NFT_MARKET_ADDRESS,
      startBlock: FND_START_BLOCK,
    },

    // ── Foundation collection factories (DISCOVERY-ONLY) ──────────────
    // We index NFTCollectionCreated to populate fnd_collections, which
    // tells the worker which clones to scan. We do NOT subscribe to per-
    // clone Transfer events here in v2 — that work moves to the worker.
    NFTCollectionFactoryV1: {
      chain: "mainnet",
      abi: nftCollectionFactoryAbi,
      address: NFT_COLLECTION_FACTORY_V1_ADDRESS,
      startBlock: FND_START_BLOCK,
    },
    NFTCollectionFactoryV2: {
      chain: "mainnet",
      abi: nftCollectionFactoryAbi,
      address: NFT_COLLECTION_FACTORY_V2_ADDRESS,
      startBlock: FND_START_BLOCK,
    },

    // ── Catalog ───────────────────────────────────────────────────────
    Catalog: {
      chain: "mainnet",
      abi: catalogAbi,
      address: CATALOG_ADDRESS,
      startBlock: CATALOG_DEPLOY_BLOCK,
    },

    // ── SuperRare V2 shared 1/1 ───────────────────────────────────────
    // Sparse contract. Artist = recipient of mint, so this is identity-
    // shaped, not marketplace-shaped. Kept in Ponder.
    SuperRareNFT: {
      chain: "mainnet",
      abi: superrareNftAbi,
      address: SR_V2_NFT_ADDRESS,
      startBlock: SR_V2_NFT_DEPLOY_BLOCK,
    },

    // ── MintFactory (DISCOVERY-ONLY) ──────────────────────────────────
    MintFactory: {
      chain: "mainnet",
      abi: mintFactoryAbi,
      address: MINT_FACTORY_ADDRESS,
      startBlock: MINT_FACTORY_DEPLOY_BLOCK,
    },

    // ── TLUniversalDeployer (DISCOVERY-ONLY) ──────────────────────────
    TLUniversalDeployer: {
      chain: "mainnet",
      abi: tlUniversalDeployerAbi,
      address: TL_DEPLOYER_ADDRESS,
      startBlock: TL_DEPLOYER_DEPLOY_BLOCK,
    },

    // ── MURI Protocol singleton (preservation overlay) ────────────────
    // Fixed shared contract → belongs in Ponder (per AGENTS.md), NOT the
    // worker long tail. Drives muri_contracts + muri_tokens.
    MURIProtocol: {
      chain: "mainnet",
      abi: muriProtocolAbi,
      address: MURI_PROTOCOL_ADDRESS,
      startBlock: MURI_PROTOCOL_DEPLOY_BLOCK,
    },

    // ── PND Surface System (DEPLOY-GATED — see sentinel above) ────────
    // Both entries are conditionally spread in: while
    // SURFACE_FACTORY_ADDRESS is the zero-address sentinel,
    // neither key exists on `contracts` at all (not "disabled", just
    // absent), so this file stays a valid, runnable Ponder config before
    // deploy. Fill in the real factory address + deploy block, and both
    // entries activate together.
    ...(SURFACE_FACTORY_IS_DEPLOYED
      ? {
          // Fixed factory — discovery (one SurfaceCreated per artist
          // deploy) exactly like SovereignAuctionHouseFactory above.
          SurfaceFactory: {
            chain: "mainnet",
            abi: surfaceFactoryAbi,
            address: SURFACE_FACTORY_ADDRESS,
            startBlock: SURFACE_FACTORY_DEPLOY_BLOCK,
          },
          // Full per-clone indexing of every deployed collection, via
          // Ponder's factory() child-address pattern (same mechanism as
          // SovereignAuctionHouse). This is a PND-owned factory, so full
          // state-machine indexing here is in-bounds per AGENTS.md — it
          // is NOT the long-tail per-artist-platform scanning that
          // belongs in the worker.
          Surface: {
            chain: "mainnet",
            abi: surfaceAbi,
            address: factory({
              address: SURFACE_FACTORY_ADDRESS,
              event: parseAbiItem(
                "event SurfaceCreated(address indexed owner, address indexed collection, uint8 idMode)",
              ),
              parameter: "collection",
            }),
            startBlock: SURFACE_FACTORY_DEPLOY_BLOCK,
          },
        }
      : {}),
  },
})
