# Artist Auction Page

Your own auction page, on your own domain — pulling live and past auction data straight from your `SovereignAuctionHouse` smart contract on Ethereum.

- **Live auction state**: current bid, time remaining, bid history, all live on-chain
- **Past auctions**: every settled or cancelled auction you've ever run
- **Bidding in-page**: visitors connect their wallet and bid without leaving your site
- **Link previews**: Twitter / Farcaster / Discord / iMessage all unfurl with the artwork and current bid
- **No backend, no database, no signup**: works out of the box on the free public RPCs

---

## Deploy

You'll need an Ethereum wallet address. Pick one path:

### Recommended: Vercel (one click)

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Fripe0x%2Fartist-auction-page&env=NEXT_PUBLIC_ARTIST_ADDRESS&envDescription=Your%20wallet%20address)

Creates a real GitHub fork in your account and deploys it. When this template ships updates, you click "Sync fork" on GitHub and Vercel auto-deploys the new version. No terminal needed, ever.

### Alternative: Netlify (two clicks)

Netlify's one-click deploy button creates a *standalone* repo with no upstream link, which means future updates require git on the command line. To get the same easy-update behavior as the Vercel path, do these two steps instead:

1. **[Fork the template on GitHub](https://github.com/ripe0x/artist-auction-page/fork)** — click "Create fork".
2. **[Open Netlify's import page](https://app.netlify.com/start)** — pick your fork from the list. When prompted, set the env var `NEXT_PUBLIC_ARTIST_ADDRESS` to your wallet address.

Two clicks instead of one, but every future update lands via "Sync fork" on GitHub the same way.

### Which to pick

| | Vercel | Netlify (2-step) |
|---|---|---|
| Setup | 1 click | 2 clicks |
| Future updates | "Sync fork" on GitHub | "Sync fork" on GitHub |
| Free tier traffic | Unlimited at this scale | Unlimited at this scale |
| Terms of service | "Hobby" tier is officially for non-commercial use | No restriction |

If unsure, pick Vercel for speed. If the Hobby ToS matters to you, the 2-step Netlify path gets you the same outcome with one extra click.

---

## What you'll fill in

The deploy form asks for two things:

| Variable | Required | What to put |
|---|---|---|
| `NEXT_PUBLIC_ARTIST_ADDRESS` | **Yes** | Your Ethereum wallet address (`0x…`). The page surfaces every auction this wallet has on supported marketplaces. |
| `NEXT_PUBLIC_RPC_URL` | No, but recommended | Your own RPC URL (Alchemy, Infura, etc). Makes the page noticeably faster. Leave blank to use the bundled defaults. See [Add your own RPC key](#add-your-own-rpc-key-recommended) below. |

That's the whole form. Your display name, avatar, bio, and social links come from your ENS profile automatically — no configuration needed if you've set those up there. (If you haven't, the page falls back to a shortened address. You can override anything later — see [Customize](#customize).)

---

## Add your own RPC key (recommended)

Your page works the moment you deploy it — no signup needed. But if you want it to feel snappier, sign up for a free Alchemy account and paste your URL into the `NEXT_PUBLIC_RPC_URL` setting. With your own key:

- **Pages load faster.** Especially the first visit each minute.
- **New listings appear sooner.** Without a key, a brand-new auction can take up to a minute to show up on your homepage. With one, you can configure it to appear within seconds.
- **Bids feel more responsive.** Refreshing current bids and countdowns happens faster.

It's free, takes about two minutes, and you can change it later without breaking anything.

1. Go to [alchemy.com](https://www.alchemy.com), sign up for a free account.
2. Create a new "App", chain "Ethereum Mainnet".
3. Click "API Key" and copy the URL (looks like `https://eth-mainnet.g.alchemy.com/v2/abc123…`).
4. In your hosting provider's dashboard, find the **Environment Variables** section, add `NEXT_PUBLIC_RPC_URL` with that value, then redeploy.

If you ever want to remove the key, you can — the page falls back to the bundled defaults automatically.

---

## Things to know

A few small details about how the page works that are worth understanding:

- **New listings appear within about a minute.** When you create a new auction, your page caches its current state for a minute at a time so it can stay fast for visitors. So a brand-new listing will show up on your homepage within ~60 seconds, not instantly. Active auctions you're already viewing update much faster — the current bid and countdown refresh every few seconds.

- **No database. The page reads everything from the blockchain.** This is what keeps it free to run and means you'll never pay a hosting bill for a database. The trade-off is that your first visitor each minute pays a tiny extra cost while the page refreshes its data — usually 1–3 seconds. Everyone after that gets a cached version instantly.

- **Artwork comes from each NFT directly.** Most pieces store their image data on IPFS (a decentralized file network). Brand-new pieces sometimes take a few seconds to appear the first time because the gateways serving the file are still warming up. If an image still isn't showing after a minute, hard-refresh the page.

- **Your name comes from ENS.** If you have a primary ENS name set on your wallet (like `yourname.eth`), it appears as your display name automatically. Avatar, bio, and social links also come from your ENS profile if you've set those records (`avatar`, `description`, `url`, `com.twitter`, etc).

- **Wallet support.** The connect button works for any browser-extension wallet (MetaMask, Rabby, Frame, Brave Wallet, OKX, Phantom, etc.), Coinbase Wallet, and Safe — no setup needed on your part. Mobile users connecting via WalletConnect QR codes (Rainbow mobile, Trust, MetaMask Mobile) are not enabled by default to keep your deploy zero-config; if a mobile visitor needs to bid, the easiest workaround is to open your site inside their wallet's built-in browser. To enable WalletConnect mobile QR connections, see the Customize section below.

- **Updating the template.** If a marketplace upgrades their contract or this template gets new features, you'll pull the latest version and redeploy. We'll publish announcements when these come out.

---

## Customize

Most artists won't need to change anything beyond the wallet address — ENS handles the rest. But everything is overridable via env var if you want a custom presentation:

| Variable | What it does |
|---|---|
| `NEXT_PUBLIC_ARTIST_NAME` | Display name override (otherwise: ENS reverse → truncated address). |
| `NEXT_PUBLIC_ARTIST_AVATAR_URL` | Avatar URL override (otherwise: ENS `avatar` text record → address-derived gradient). |
| `NEXT_PUBLIC_ARTIST_BIO` | Bio override (otherwise: ENS `description` text record → empty). |
| `NEXT_PUBLIC_ARTIST_LINKS` | Comma-separated social URLs (otherwise: ENS `url` / `com.twitter` / `org.farcaster` / `com.github` text records → empty). |
| `NEXT_PUBLIC_RPC_URLS` | Comma-separated RPC URL chain. Use this if you want to specify your own multi-endpoint failover. |
| `NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID` | Set this to enable WalletConnect mobile QR connections (Rainbow, Trust, MetaMask Mobile, etc). Free, takes 2 min: register at [cloud.reown.com](https://cloud.reown.com), copy the project ID, paste it here. Without this, the connect modal still shows MetaMask, Rabby, Coinbase Wallet, Safe, and other browser-extension wallets. |

To customize the look itself: this is a regular Next.js codebase. Fork it, edit the components, redeploy. See **What's where** at the bottom for the file map.

---

## Adding a custom domain

Both Vercel and Netlify make this a couple of clicks plus one DNS record. Their docs are clearer than anything we'd write here:

- [Vercel: Add a custom domain](https://vercel.com/docs/projects/domains/add-a-domain)
- [Netlify: Configure a custom domain](https://docs.netlify.com/domains-https/custom-domains/)

---

## Local development

```bash
git clone <your-fork-url>
cd artist-auction-page
npm install
cp .env.example .env.local
# edit .env.local with your wallet address
npm run dev
```

Open <http://localhost:3000>.

---

## Troubleshooting

**"Auction house not deployed"** — your wallet hasn't deployed a `SovereignAuctionHouse` yet. Deploy one in the main app first, then your auctions will show up here.

**Past auctions take a long time to load** — first load scans on-chain events from your house's deploy block. Subsequent visits hit the cache. If it's persistently slow, [add an RPC key](#add-your-own-rpc-key-recommended).

**An auction's image isn't loading** — the page reads `tokenURI` directly from the NFT contract and races public IPFS gateways for IPFS-hosted images. For brand-new pieces, gateways may be slow on first request. The image will appear once one responds.

**A bid shows the wrong amount or is stuck** — the page polls on-chain state every block (~12 seconds). If your transaction confirmed but the page hasn't updated, refresh.

**Link previews show stale info** — Twitter, Farcaster, etc. cache unfurl images aggressively. A new bid won't show up in social previews until their cache expires (a few minutes to a few hours).

---

## What's where

```
app/
  page.tsx                       # Index — artist hero + auctions masonry
  auction/[auctionId]/page.tsx   # Detail page with sticky artwork + bid form
  opengraph-image.tsx            # Social-share image for the index
  auction/[auctionId]/opengraph-image.tsx  # Per-auction social-share image
  layout.tsx                     # Root layout + providers
  globals.css                    # Theme tokens + Tailwind 4
components/
  Navbar.tsx                     # Top nav (wordmark + theme toggle + connect)
  ArtistHero.tsx                 # Avatar / name / counts / pill row
  AuctionCard.tsx                # Grid card
  AuctionCardImage.tsx           # Native-aspect-ratio image renderer
  TokenMedia.tsx                 # Sticky-column media for detail page
  BidForm.tsx                    # Live bid + settle controls (client)
  BidHistory.tsx
  SettledSummary.tsx             # Past-auction summary panel
  Footer.tsx
  ThemeToggle.tsx
lib/
  config.ts                      # Typed env-var loading
  artist.ts                      # Display name / avatar / bio / links resolution (env → ENS → fallback)
  ens.ts                         # Cached ENS name + text record reads
  rpc.ts                         # Public RPC failover + dynamic getLogs chunking
  auctions.ts                    # House resolution + auction list + bid history
  metadata.ts                    # On-chain tokenURI + IPFS gateway race
  format.ts                      # ETH / address / time / display formatting
  wagmi-config.ts                # Browser-side wagmi + RainbowKit config
  abi/                           # Vendored ABIs (SovereignAuctionHouse, Factory, ERC721)
```

---

## License

MIT.
