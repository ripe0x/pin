/**
 * FAQ list. Each row is a question (sans, medium weight) over an answer
 * (sans, muted, comfortable line-height). Border-b between rows for visual
 * rhythm, no expand/collapse — answers are short enough to read at a glance.
 *
 * Copy reflects what's actually shipped today: Sovereign auction houses
 * only. Add entries about other marketplaces only when those code paths
 * land.
 */
const items: Array<{ q: string; a: string | React.ReactNode }> = [
  {
    q: "Is it really free to host?",
    a: "Yes. Vercel Hobby and Netlify Free both handle this comfortably for any normal artist traffic, including page views, link unfurls, and bidding. You can upgrade your hosting plan later if you ever need to.",
  },
  {
    q: "Vercel or Netlify?",
    a: "Vercel is one click and forks the template into your GitHub account, so future updates land via GitHub's Sync fork button. Netlify's one-click deploy creates a standalone repo with no upstream link, which means future updates require git on the command line. The page offers a two-step Netlify path (fork on GitHub, then import into Netlify) that gets you the same easy-update behavior. Vercel's Hobby tier is officially for non-commercial use; Netlify has no such restriction. If unsure, pick Vercel.",
  },
  {
    q: "What does it cost in fees or gas?",
    a: "Nothing from this page. Bids and settlement transactions hit your auction house contract directly. The protocol fee on that contract is whatever you set when you deployed it (typically 0%). No marketplace tax sits in between.",
  },
  {
    q: "How fast is it?",
    a: "Most page loads are under 100ms. The first visitor each minute pays a tiny refresh cost (1 to 3 seconds) while the page pulls fresh data from the blockchain. Everyone after that gets a cached version. Adding your own RPC key (free Alchemy) makes the refresh basically instant.",
  },
  {
    q: "Can I customize how it looks?",
    a: "Yes. It's a regular Next.js codebase you've got full access to. Fork it, restyle it, change the colors, swap the layout. The README walks through where each piece lives.",
  },
  {
    q: "What if my wallet doesn't have an ENS name?",
    a: "The page falls back to your shortened address (like 0x1234…abcd). You can override the display name with one env var if you want a custom one, no ENS required.",
  },
  {
    q: "Do I need to host an RPC?",
    a: "No. The page works out of the box using free public RPCs. Adding your own free Alchemy URL makes things faster but isn't required.",
  },
  {
    q: "What about other marketplaces?",
    a: "Today this template surfaces auctions on your Sovereign auction house only. Pulling listings from other marketplaces is on the roadmap. When it lands, you'll click Sync fork on your GitHub fork and your live site auto-redeploys.",
  },
  {
    q: "Can I use a custom domain?",
    a: "Yes. Both Vercel and Netlify let you connect any domain you own with one DNS record. Their docs walk you through it.",
  },
  {
    q: "Does this replace my profile in the main app?",
    a: "No. They coexist. The main app remains your discovery surface, your gallery, and your auction-creation tool. The artist site is your own page, the place you'd link in your bio.",
  },
  {
    q: "What about bidding from a mobile wallet?",
    a: "The connect button works for any browser-extension wallet (MetaMask, Rabby, Frame, Brave, Coinbase Wallet, Safe, and others). Mobile users connecting via WalletConnect QR codes are off by default to keep your deploy zero-config. The easiest workaround is to open the site inside your wallet's built-in browser. Enabling WalletConnect mobile is one optional env var if you want it.",
  },
  {
    q: "What happens when the auction contract upgrades?",
    a: "Click Sync fork on your GitHub fork. Vercel or Netlify auto-redeploys the new version. We'll announce these when they happen.",
  },
]

export function Faq() {
  return (
    <section className="py-16 border-t border-gray-200">
      <div className="grid gap-12 lg:grid-cols-[1fr_2fr]">
        <div>
          <p className="text-[11px] font-mono uppercase tracking-wider text-gray-500">
            FAQ
          </p>
          <h2 className="text-2xl sm:text-3xl font-semibold tracking-tight mt-2">
            Common questions.
          </h2>
        </div>
        <dl className="divide-y divide-gray-200 border-t border-b border-gray-200">
          {items.map(({ q, a }) => (
            <div key={q} className="py-5 grid gap-2">
              <dt className="text-base font-medium">{q}</dt>
              <dd className="text-sm text-fg-muted leading-relaxed max-w-prose">
                {a}
              </dd>
            </div>
          ))}
        </dl>
      </div>
    </section>
  )
}
