# PND

PND is open source artist infrastructure owned by the artist.

Artists can preserve work, manage listings, deploy their own auction contracts, run ETH reserve auctions, and build on public tools without relying on a single platform interface.

The goal is simple:

make artists more capable.

PND is built for artists who want to understand the stack around their work, own more of it, and keep that infrastructure portable, inspectable, and forkable.

## Why this exists

Crypto art gives artists a new kind of leverage.

The work, contract, sale, record, and collector relationship can all live on public infrastructure. That means artists can own more than the final object. They can own more of the system around it.

PND exists to make that easier.

It provides tools for preservation, artist profiles, listing management, auction migration, and artist owned auction contracts. The interface is useful, but the deeper point is the infrastructure underneath it.

The contracts are open.
The frontend is open.
The packages are reusable.
The system is meant to be forked.

Artists should have more ways to act directly inside the medium they are working in.

## What artists can do

PND currently supports:

1. Preserve token metadata and media on IPFS
2. View artist profiles across supported contracts
3. Look up tokens created by an artist
4. Manage listings on supported marketplace contracts
5. Delist tokens from supported auction contracts
6. Deploy your own Sovereign Auction House
7. List ERC721 tokens for ETH reserve auctions
8. Migrate active listings into your own auction contract
9. Fork the frontend or build a new interface on the same contracts

## Sovereign Auction Houses

A Sovereign Auction House is an artist controlled auction contract.

Each house is deployed from a public factory as an EIP1167 minimal proxy. The contracts are immutable, permissionless, and intentionally small.

There are no admin keys.
There is no upgrade path.
There is no curator role.
There are zero platform fees.

The contract supports ETH reserve auctions for ERC721 tokens.

This is intentionally simple. The goal is to make the auction layer portable, inspectable, and controlled by the artist wallet.

An artist can use the PND interface to deploy and manage their auction house, but the contracts are public infrastructure. Other people can build their own interfaces on top of them too.

That is the point.

## Preservation and legacy support

PND began as a response to Foundation going offline.

That support still exists. Artists can look up Foundation minted work, pin metadata and media to IPFS, delist from Foundation auction contracts, and migrate active listings to their own auction house.

Those tools are part of PND because old dependencies should not trap living work.

But PND is no longer only a recovery tool. It is infrastructure artists can keep using, for Foundation work and beyond.

## Architecture

```txt
apps/
  web/          Next.js 15 frontend
                React 19, Tailwind v4, wagmi v2, RainbowKit

contracts/     Solidity source for the Sovereign Auction House
                and its EIP1167 minimal proxy factory

packages/
  abi/          Hand written ABI exports for viem type inference
  addresses/    Contract addresses per chain
  shared/       Site config, IPFS utilities, shared types

ponder/         Optional event indexer for PND auction houses
                (Ponder + Postgres). See "Data layer" below.

db/             SQL migrations + a Node migration runner for the shared
                Postgres cache table.

scripts/        Local fork helpers, ABI emit scripts, and dev utilities
```

## Core design choices

### Open source artist infrastructure

PND is built so artists and builders can inspect, fork, and extend the tools around their work.

The frontend is open source.
The contracts are open source.
The ABIs and address packages are reusable.
The shared utilities are open.
The system is meant to support more than one interface.

### Public contracts

The auction contracts are public, immutable, and permissionless.

Anyone can inspect them.
Anyone can deploy through the factory.
Anyone can build another interface on top of them.

### Built to be forked

PND is MIT licensed.

Use the frontend, contracts, ABI package, address package, and shared utilities as they are, or modify them for your own needs.

## Data layer

PND reads from a layered stack. Server components and route handlers walk it
top to bottom, stopping at the first hit:

```txt
1. unstable_cache   in-process, ~ms
                    Lives in the Netlify Function instance's memory.
                    Per-instance, dies on cold start.

2. pgCache          Postgres KV table (cache_entries), ~10-50ms
                    Shared across every Function instance and edge region.
                    Bigints stringified at the boundary; JSONB column.

3. Ponder           Postgres tables (ponder.pnd_auctions, ponder.pnd_bids)
                    populated by a separate long-running Ponder service.
                    Live event-streamed from chain; ~10-50ms point lookups.
                    Used for PND auction state queries today; the indexer
                    is opt-in (see `INDEXER_DISABLED`).

4. RPC              Any JSON-RPC provider, via the /api/rpc proxy. The
                    slowest layer, and the only one that contacts an
                    external service per call. The proxy holds the API
                    key server-side, allowlists methods, and rate-limits
                    per IP.
```

Every layer has a kill switch. `DATABASE_URL` unset → pgCache and indexer
queries no-op and the app behaves as if neither exists, falling through to
RPC + the in-process cache. `INDEXER_DISABLED=1` skips Ponder reads only.

### Why this shape

The motivation is to rely less on direct RPC calls. The original frontend
hit chain on every render — every visitor, every bot, every refresh —
which made even basic pages dependent on a single provider's quota and
latency, and exposed the API key to anyone who could view-source the
client bundle. A single Foundation contract scan could take 18 seconds
on a cold cache. This layout fixes those structurally:

1. **Key out of the bundle.** Wagmi and any client-side viem clients
   route through `/api/rpc`. The secret stays on the server, behind a
   method allowlist and per-IP rate limit at the proxy.
2. **Repeat traffic skips the provider.** Hot pages serve from the
   in-process cache; cross-instance traffic shares the Postgres
   layer; only the first miss per TTL window reaches RPC at all.
3. **Wide log scans become point queries.** Ponder eagerly indexes
   every PND auction event and writes them to Postgres.
   `getActiveAuctionCount` is now a `COUNT(*)` against an indexed
   table instead of a deploy-block-to-tip `getLogs` scan plus N
   parallel reads.
4. **Bid + settle invalidations are surgical.** A bidder calls
   `/api/auction/revalidate?contract=…&tokenId=…` after their tx
   confirms. Only that one auction's cache entries get flushed, in
   both layers.

### What's actually cached

```txt
ens:0xabc                          ENS reverse, 24h
token-metadata:0xabc:1             tokenURI + IPFS metadata, 1h
token-onchain-data:0xabc:1         owner + transfer history, 60s
erc1155-stats:0xabc:1              supply + holders, 60s
auction:0xabc:1                    auction state, 30s, dynamic per-token tag
active-auction-count:0xabc         count for an artist, 5min
last-sale:0xabc:1                  most recent sale price, 1h
seller-listings:                   not pgCached (callers are client comps;
                                   see lib/seller-listings.ts comment)
```

ERC1155 transfer history uses the Alchemy NFT API rather than `eth_getLogs`
because the latter would require a contract-wide scan filtered in memory.
ERC721 transfer history stays on indexed-topic `getLogs` — Alchemy's
transfer API doesn't support tokenId filtering and the contract-wide page
walk was 10× slower on Foundation's shared NFT contract.

### Self-hosting the data layer

The data layer is optional. The minimum runnable setup is just the
Next.js app pointed at any RPC provider — no Postgres, no Ponder.

To replicate the production stack:

1. **Postgres** anywhere (Railway, Neon, Supabase, local). Apply the
   migration once with `npm run db:migrate` (reads `DATABASE_URL`
   from `apps/web/.env.local`).
2. **Ponder** as a separate long-running service. The `ponder/`
   directory is self-contained. See [`ponder/README.md`](./ponder/README.md)
   for required env vars, RPC requirements, and recovery from stuck
   schema state.
3. **Web app**: set `DATABASE_URL` and `INDEXER_SCHEMA=ponder`.

Operational notes — Netlify deploy specifics, Postgres pooling,
verification queries, cost expectations, kill switches, local dev —
live in [`DEPLOYMENT.md`](./DEPLOYMENT.md).

### Forking and provider choice

The app talks to mainnet through one env var: `MAINNET_RPC_URL`. Point it
at any JSON-RPC compatible endpoint (Alchemy, Quicknode, drpc, a
self-hosted node) and the core experience works.

Some features rely on Alchemy's enhanced NFT API and only light up when
`ALCHEMY_API_KEY` is also set. They degrade silently (empty results, no
crashes) without it:

| Feature | What's broken without `ALCHEMY_API_KEY` | Code path |
|---|---|---|
| Manifold artist gallery | Manifold creators show "No works found" | [`lib/manifold-discovery.ts`](./apps/web/src/lib/manifold-discovery.ts) `enumerateRefsViaAlchemyNft` |
| Collector page — Manifold | Manifold section empty on `/collector/[address]` | [`lib/platforms/manifold.ts`](./apps/web/src/lib/platforms/manifold.ts) `discoverCollectorTokens` (uses `getAllNFTsForOwner`) |
| Collector page — Foundation | Foundation section empty | [`lib/platforms/foundation.ts`](./apps/web/src/lib/platforms/foundation.ts) `discoverCollectorTokens` (uses `getNFTsForOwner`) |
| Collector page — SuperRare V2 | SuperRare section empty | [`lib/platforms/superrareV2.ts`](./apps/web/src/lib/platforms/superrareV2.ts) `discoverCollectorTokens` (uses `getNFTsForOwner`) |
| ERC-1155 supporter / holder stats | No supporters list, no mint counts on token pages | [`lib/onchain-discovery.ts`](./apps/web/src/lib/onchain-discovery.ts) `getErc1155TokenStatsUncached` (uses `alchemy_getAssetTransfers` and `getOwnersForNft`) |

What works on plain RPC, no Alchemy required:
- Artist pages for Foundation, SuperRare, Sovereign, and Transient
  (event-scan based)
- Sovereign auction house deploys, listings, bids, settles, migrations,
  bulk delist / cancel
- ENS resolution, token detail pages, the home activity feed (which
  reads from the Ponder indexer, not RPC)
- The `/api/rpc` proxy itself, with automatic fallback through public
  RPCs when the configured primary is unhealthy

These coupled paths use `alchemy_getAssetTransfers` (a non-standard
JSON-RPC extension) and the `/nft/v3/...` REST endpoints, neither of
which any other provider implements drop-in. Replacing them with plain
`eth_getLogs` is feasible for the bounded cases (Foundation + SuperRare
collector, the known-contract Manifold artist enumeration) but
expensive for the open-universe Manifold collector — better solved by
extending the Ponder indexer than by per-render RPC scans.

The optional `INFURA_API_KEY` is read only by the `/api/rpc` proxy as a
secondary authenticated fallback. The proxy detects Infura's
free-tier `eth_getLogs` block-range error and falls through to public
RPCs without the cap, so Infura usefully covers everything except wide
log scans.

## Features

### Artist profiles and lookup

Enter an Ethereum address or ENS name to load an artist profile, supported tokens, listings, and available actions.

### Contract based token lookup

Read supported contracts to resolve tokens created by an artist.

### IPFS preservation

Pin metadata and media CIDs to a pinning provider in a few clicks.

Artists bring their own API key from Pinata or 4EVERLAND. Keys stay in the browser and are sent directly to the provider. They are never stored on a PND server.

### Artist profiles

Server rendered profile pages live at:

```txt
/artist/[address]
```

Profiles include ENS resolution, shareable URLs, and Open Graph metadata.

### Token detail pages

Token pages resolve creator, owner, transfer history, metadata, and media from RPC and IPFS.

### Video NFT support

Supported video formats include mp4, mov, and webm.

### Listing management

Cancel supported reserve auctions and buy nows before a bid has been placed.

### Auction house deployment

Deploy your own immutable auction contract from your artist profile.

### Migration flow

Migrate supported active listings into your own auction house from:

```txt
/artist/[address]/migrate
```

### Bulk listing and cancellation

List multiple owned tokens for auction and cancel eligible auctions in batches when supported.

### Mainnet and local fork support

The same UI runs against Ethereum mainnet or a local Anvil fork.

### Wallet connection

Wallet support is provided through RainbowKit.

## Auctions

PND currently supports three auction flows.

### Manage listings on supported marketplace contracts

Artists can cancel eligible reserve auctions and buy nows from their profile page.

For Foundation listings, this interacts with the Foundation NFTMarket contract directly. The Foundation frontend is offline, but the contract still exists onchain.

### Run new auctions on your own house

Once an artist deploys an auction house, they can list ERC721 tokens they own.

Collectors can bid, settle, and view auction state through the PND interface or any other interface that supports the same contracts.

### Migrate active listings

The migration flow helps artists move supported active listings into their own auction house.

For each listing, PND cancels the original listing and recreates it on the artist owned house with the selected reserve and duration.

## Auction contract behavior

Each auction house has the following properties:

1. Immutable after deployment
2. No admin keys
3. No upgrade path
4. No curator role
5. Zero platform fees
6. ETH bids only
7. ERC721 support
8. Reserve auctions
9. Auction timer starts when the first bid meets the reserve
10. Five percent minimum bid increment
11. Fifteen minute late bid extension
12. Only the artist can list tokens on their house

The factory is open and permissionless. Anyone can deploy a house for any wallet.

## Prerequisites

1. Node.js 18 or newer
2. npm 9 or newer
3. An Alchemy API key (or any JSON-RPC provider — `ALCHEMY_API_KEY` is
   the env var name; the URL is constructed from it server-side)
4. A WalletConnect project ID
5. Optional: a Postgres database for the shared cache layer (Railway,
   Neon, Supabase, or local — see "Data layer" above)
6. Optional: a separately-deployed Ponder service for live PND auction
   indexing (see `ponder/`)
7. Optional: Foundry for local mainnet fork testing

## Setup

```bash
git clone <repo-url> && cd pin
npm install

cp apps/web/.env.example apps/web/.env.local
```

Then edit:

```txt
apps/web/.env.local
```

Add your API keys and local configuration. Required:

```txt
ALCHEMY_API_KEY              server-only; constructs the upstream URL
                             that /api/rpc proxies to
NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID
                             RainbowKit/WalletConnect handshake
```

Optional (enables the shared cache + indexer; the app falls back
gracefully when these are unset):

```txt
DATABASE_URL                 Postgres connection string for pgCache + Ponder
INDEXER_SCHEMA               schema name where Ponder writes its tables
                             (default: "ponder"); only relevant if you
                             deploy the indexer service
INDEXER_DISABLED             set to "1" to bypass indexer reads even
                             when DATABASE_URL is set
ALCHEMY_STATS_SECRET         optional; gates a future /api/rpc/stats
                             observability endpoint
REVALIDATE_SECRET            arbitrary string; required only if you want
                             authenticated cache flushes via
                             /api/revalidate?secret=…
```

Once `DATABASE_URL` is set, apply the migration:

```bash
npm run db:migrate
```

## Development

```bash
npm run dev
```

The app will be available at:

```txt
http://localhost:3000
```

## API routes

The web app exposes a small set of route handlers. All are safe to leave
public; none accept arbitrary-method calls.

```txt
POST /api/rpc                 JSON-RPC proxy. Method allowlist + per-IP
                              rate limit. Hides ALCHEMY_API_KEY from the
                              client bundle.

POST /api/auction/revalidate  Surgical per-(contract, tokenId) cache flush.
                              Called by AuctionPanel after a bid / settle /
                              cancel / reserve update tx confirms. Per-IP
                              rate-limited.

GET  /api/revalidate          Manually flush the artist gallery + token
                              caches. Optional secret param skips the
                              rate limit; otherwise public, 1/min/IP.
                              Powers the in-page "↻ Refresh" pill.

GET  /api/meta/[contract]/[tokenId]
                              OG metadata endpoint. Delegates to the
                              cached resolveTokenMetadataDirect — no
                              local viem client, no secret in bundle.

GET  /api/artist/[address]/tokens?page=N
GET  /api/artist/[address]/preserve-tokens
                              Artist gallery + preserve flow data.
                              Wraps the same cached lib functions the
                              SSR uses.
```

## Local fork testing

The wagmi config in:

```txt
apps/web/src/lib/wagmi.ts
```

supports both Ethereum mainnet and Foundry.

Set:

```txt
NEXT_PUBLIC_ALCHEMY_MAINNET_URL
```

to your Anvil RPC and the app will read from a local mainnet fork.

```bash
anvil --fork-url $ALCHEMY_URL
```

Then point the web app at the fork:

```bash
echo 'NEXT_PUBLIC_ALCHEMY_MAINNET_URL=http://localhost:8545' >> apps/web/.env.local
npm run dev
```

In MetaMask, add a custom network:

```txt
RPC: http://localhost:8545
Chain ID: 31337
```

Switch to that network before signing. Writes go to whatever chain your wallet is connected to.

## Scripts

Helper scripts live in:

```txt
scripts/
```

Current helpers include:

```txt
fork-fast-forward.mjs
```

Advance fork timestamp to settle expired auctions in tests.

```txt
fork-reclaim-token.mjs
```

Impersonate a holder and pull a token to your dev wallet.

```txt
emit-sovereign-abi.mjs
```

Regenerate ABI exports after contract changes.

For Foundry tests and deploys of the auction contracts, see:

```txt
contracts/README.md
```

## Contracts

### Sovereign Auction House

```txt
SovereignAuctionHouseFactory
0xaE712abcA452901A74D1FBC0c3919F2cc060EF9f
```

```txt
Per artist house
deployed on demand through factory.createAuctionHouse()
```

The factory was deployed on 2026 04 27.

Protocol fee:

```txt
0 bps
```

Contract properties:

```txt
immutable
permissionless
no admin keys
no upgrade path
```

Source code and deploy instructions are available in:

```txt
contracts/
contracts/README.md
```

### Supported Foundation contracts

PND supports several Foundation contracts for preservation, lookup, delisting, and migration flows.

```txt
FoundationNFT shared contract
0x3B3ee1931Dc30C1957379FAc9aba94D1C48a5405
```

```txt
NFTCollectionFactory V1
0x3B612a5B49e025a6e4bA4eE4FB1EF46D13588059
```

```txt
NFTCollectionFactory V2
0x612E2DadDc89d91409e40f946f9f7CfE422e777E
```

```txt
NFTMarket proxy
0xcDA72070E455bb31C7690a170224Ce43623d0B6f
```

Foundation protocol source:

```txt
https://github.com/f8n/fnd-protocol
```

## Stack

```txt
Next.js 15
React 19
TypeScript 5.7
Tailwind CSS v4
wagmi v2
viem v2
RainbowKit v2
TanStack React Query v5
Foundry
```

## Packages

### ABI package

```txt
packages/abi
```

Hand written ABI exports with const assertions for viem type inference.

Use this package if you want typed contract bindings in another frontend.

### Addresses package

```txt
packages/addresses
```

Contract addresses per chain.

### Shared package

```txt
packages/shared
```

Site configuration, IPFS utilities, and shared types.

## Build on it

PND is open source because the goal is not to trap artists inside another interface.

Fork the frontend.
Use the contracts.
Build a better viewer.
Build a collector app.
Build an auction surface for a specific community.
Replace the preservation backend.
Deploy the contracts on another chain.

The infrastructure is open so the work can keep moving.

Some directions worth exploring:

1. A curator focused interface for a specific collection or community
2. Multi chain auction house deployments
3. Auction embeds for artist websites
4. Read only collector dashboards
5. Alternative preservation backends such as Arweave or Storj
6. Mobile first artist profiles
7. Tools for institutions managing artist estates or archives
8. Custom auction surfaces for galleries, collectives, and independent curators

Open an issue, submit a pull request, or fork it and ship.

## License

MIT.

No attribution requirement.
No commercial restriction.
No contributor agreement.

If you build something with PND, I would love to see it.
