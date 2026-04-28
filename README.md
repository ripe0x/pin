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

## Current frontend architecture

The current PND frontend reads from onchain RPC and IPFS for artist profiles, token pages, preservation flows, listing management, and auction actions.

That keeps the app relatively lightweight and easy to run today.

Over time, PND may add indexing or other infrastructure where it improves speed, reliability, or scale. The goal is to keep the important pieces open, understandable, and portable.

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
3. An Alchemy API key
4. A WalletConnect project ID
5. Optional: Foundry for local mainnet fork testing

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

Add your API keys and local configuration.

## Development

```bash
npm run dev
```

The app will be available at:

```txt
http://localhost:3000
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
