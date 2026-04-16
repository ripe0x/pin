# pin

Discover Foundation artists, explore their work, and preserve art on IPFS.

Foundation.app is shutting down — both the frontend and IPFS pinning for all minted tokens. **pin** helps artists preserve their work before it disappears: discover all tokens an artist minted on Foundation, pin them to IPFS with a few clicks, and share a permanent portfolio page.

## Architecture

```
apps/
  web/         Next.js 15 frontend (React 19, Tailwind v4, wagmi v2, RainbowKit)
  indexer/     Ponder indexer (optional — on-chain event processing, GraphQL API)
packages/
  abi/         Hand-written ABI exports (as const, for viem type inference)
  addresses/   Contract addresses per chain
  shared/      Site config, IPFS utilities, shared types
```

**No indexer dependency** — The core features (artist pages, token discovery, IPFS preservation) work entirely from on-chain RPC calls and IPFS fetches. The Ponder indexer is optional and only needed for enhanced token detail pages.

**BYOK pinning** — Artists bring their own API key from Pinata, web3.storage, or Filebase. Keys stay in the browser and are sent directly to the provider — never stored on any server.

## Features

- **Artist discovery** — Enter an Ethereum address or ENS name to view any Foundation artist's portfolio
- **On-chain token discovery** — Scans the FoundationNFT shared contract and per-artist collection contracts (via NFTCollectionFactory V1/V2) to find all tokens an artist minted
- **IPFS preservation** — Pin metadata and media CIDs to a pinning provider with a few clicks
- **Artist micro-site** — Server-rendered portfolio page at `/artist/[address]` with ENS resolution, OG tags, and shareable URLs
- **Token detail pages** — RPC-based creator, owner, and transfer history resolution
- **Video NFT support** (mp4, mov, webm)
- **Wallet connection** via RainbowKit (MetaMask, Rainbow, WalletConnect, etc.)

## Prerequisites

- Node.js 18+
- npm 9+
- An [Alchemy](https://alchemy.com) API key (free tier works)
- A [WalletConnect](https://cloud.walletconnect.com) project ID (free)

## Setup

```bash
git clone <repo-url> && cd pin
npm install

# Configure environment
cp apps/web/.env.example apps/web/.env.local
# Edit .env.local with your API keys
```

## Development

```bash
# Start the Next.js dev server
npm run dev
# Available at http://localhost:3000

# Optional: Start the Ponder indexer (for enhanced token detail pages)
npm run dev:indexer
# GraphQL playground at http://localhost:42069/graphql
```

## Contracts

pin reads from Foundation's deployed contracts on Ethereum mainnet:

| Contract | Address |
|----------|---------|
| FoundationNFT (shared) | `0x3B3ee1931Dc30C1957379FAc9aba94D1C48a5405` |
| NFTCollectionFactory V1 | `0x3B612a5B49e025a6e4bA4eE4FB1EF46D13588059` |
| NFTCollectionFactory V2 | `0x612E2DadDc89d91409e40f946f9f7CfE422e777E` |
| NFTMarket (proxy) | `0xcDA72070E455bb31C7690a170224Ce43623d0B6f` |

Source: [f8n/fnd-protocol](https://github.com/f8n/fnd-protocol)

## Stack

- **Next.js 15** (app router, Turbopack)
- **React 19**, **TypeScript 5.7**
- **Tailwind CSS v4**
- **wagmi v2** + **viem v2** (contract interactions)
- **RainbowKit v2** (wallet UI)
- **Ponder** (optional on-chain indexer)

## License

MIT
