# Artist Auction Page

Your own auction page, on your own domain — pulling live and past auction data straight from your `SovereignAuctionHouse` smart contract on Ethereum.

- **Live auction state**: current bid, time remaining, bid history, all live on-chain
- **Past auctions**: every settled or cancelled auction you've ever run
- **Bidding in-page**: visitors connect their wallet and bid without leaving your site
- **Link previews**: Twitter / Farcaster / Discord / iMessage all unfurl with the artwork and current bid
- **No backend, no database, no signup**: works out of the box on the free public RPCs

---

## Deploy

Click one of these and you'll be walked through deploying your own copy. You'll need an Ethereum wallet address (the one that owns your `SovereignAuctionHouse`).

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2FYOUR_ORG%2Fartist-auction-page&env=NEXT_PUBLIC_ARTIST_ADDRESS,NEXT_PUBLIC_ARTIST_NAME&envDescription=Your%20wallet%20address%20and%20display%20name)

[![Deploy to Netlify](https://www.netlify.com/img/deploy/button.svg)](https://app.netlify.com/start/deploy?repository=https://github.com/YOUR_ORG/artist-auction-page)

> **Vercel vs. Netlify?** Both work, both are free for traffic at this scale. Vercel's "Hobby" tier technically says it's for non-commercial use; Netlify has no such restriction. If unsure, pick Netlify.

---

## What you'll fill in

When the deploy form asks for environment variables, here's what each one means:

| Variable | Required | What to put |
|---|---|---|
| `NEXT_PUBLIC_ARTIST_ADDRESS` | Yes | Your Ethereum wallet address (`0x…`) — the one that owns your `SovereignAuctionHouse`. |
| `NEXT_PUBLIC_ARTIST_NAME` | No | Your display name. Defaults to the ENS reverse-resolution of your address (e.g. `vitalik.eth`), or a truncated address if you don't have an ENS name. Set this to override. |
| `NEXT_PUBLIC_ARTIST_AVATAR_URL` | No | URL to a square avatar image. |
| `NEXT_PUBLIC_ARTIST_BIO` | No | Short bio shown under your name. |
| `NEXT_PUBLIC_ARTIST_LINKS` | No | Comma-separated social URLs (e.g. `https://twitter.com/you,https://farcaster.xyz/you`). |
| `NEXT_PUBLIC_RPC_URL` | No | Your own RPC URL (Alchemy/Infura/etc). Leave blank — it works without one. See [When to add an RPC key](#when-to-add-an-rpc-key) below. |

---

## When to add an RPC key

The page works without one. It uses a curated chain of free public RPCs (PublicNode → drpc → LlamaRPC → Cloudflare) and falls over between them if any single one is having a bad day.

**You only need your own RPC URL if:**

- Your page gets a lot of traffic (hundreds of simultaneous viewers).
- Past auctions take a long time to load on first visit.
- You want faster cold rebuilds when you redeploy.

**To add one** (this takes 2 minutes):

1. Go to [alchemy.com](https://www.alchemy.com), sign up for a free account.
2. Create a new "App", chain "Ethereum Mainnet".
3. Click "API Key" and copy the URL (it looks like `https://eth-mainnet.g.alchemy.com/v2/abc123…`).
4. In your Vercel/Netlify dashboard, find the **Environment Variables** section, add a new one called `NEXT_PUBLIC_RPC_URL` with that value, and redeploy.

The runtime is robust to this URL being removed or rotated later — if the key is invalid, the page silently falls back to the public RPCs.

---

## Adding a custom domain

Both Vercel and Netlify make this a couple of clicks plus one DNS record. Their docs are clearer than anything I'd write here:

- [Vercel: Add a custom domain](https://vercel.com/docs/projects/domains/add-a-domain)
- [Netlify: Configure a custom domain](https://docs.netlify.com/domains-https/custom-domains/)

---

## Local development

```bash
git clone <your-fork-url>
cd artist-auction-page
npm install
cp .env.example .env.local
# edit .env.local with your address + name
npm run dev
```

Open <http://localhost:3000>.

---

## Troubleshooting

**"Auction house not deployed"** — your wallet hasn't deployed a `SovereignAuctionHouse` yet. Deploy one in the main app first, then your auctions will show up here.

**Past auctions take a long time to load** — first load scans on-chain events from your house's deploy block. Subsequent visits hit the cache (60-second revalidate). If it's persistently slow, [add an RPC key](#when-to-add-an-rpc-key).

**An auction's image isn't loading** — the page uses Reservoir's NFT API for fast, CDN-cached images, with public IPFS gateway fallback. For brand-new tokens Reservoir hasn't indexed yet, the IPFS gateways may be slow. The image will appear once one of them responds.

**A bid shows the wrong amount / is stuck** — the page polls on-chain state every block (~12 seconds). If your transaction confirmed but the page hasn't updated, refresh.

**Link previews show stale info** — Twitter, Farcaster, etc. cache unfurl images aggressively. A new bid won't show up in social previews until the cache expires (usually a few minutes to a few hours).

---

## What's where

```
app/
  page.tsx                       # Index — artist header + auctions grid
  auction/[auctionId]/page.tsx   # Detail page with bid form + history
  opengraph-image.tsx            # Social-share image for the index
  auction/[auctionId]/opengraph-image.tsx  # Per-auction social-share image
  layout.tsx                     # Root layout + providers
components/
  AuctionCard.tsx                # Grid card
  BidForm.tsx                    # Live bid + settle controls (client)
  BidHistory.tsx
  ArtistHeader.tsx
  ArtistIntro.tsx
lib/
  config.ts                      # Typed env-var loading
  rpc.ts                         # Public RPC failover + dynamic getLogs chunking
  auctions.ts                    # House resolution + auction list + bid history
  metadata.ts                    # Reservoir-first token metadata, IPFS fallback
  format.ts                      # ETH / address / time formatting
  wagmi-config.ts                # Browser-side wagmi + RainbowKit config
  abi/                           # Vendored ABIs (SovereignAuctionHouse, Factory, ERC721)
```

---

## License

MIT.
