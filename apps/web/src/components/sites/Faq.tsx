/**
 * FAQ list. Each row is a question (sans, medium weight) over an answer
 * (sans, muted, comfortable line-height). Border-b between rows for visual
 * rhythm, no expand/collapse — answers are short enough to read at a glance.
 */
const items: Array<{ q: string; a: string | React.ReactNode }> = [
  {
    q: "Is it really free to host?",
    a: "Yes. Vercel Hobby and Netlify Free both handle this comfortably for any normal artist traffic — page views, link unfurls, bidding. You'd only ever need to pay if your page got tens of thousands of simultaneous viewers, in which case you can upgrade your hosting plan or add a free Alchemy key.",
  },
  {
    q: "What does it cost in fees or gas?",
    a: "Nothing from this page. Bids and purchases hit the same marketplace contracts they would on any front-end — those marketplaces' own fees still apply. SuperRare adds a 3% buyer's premium on bids, for instance; the bid form shows the total before you confirm.",
  },
  {
    q: "How fast is it?",
    a: "Most page loads are under 100ms. The first visitor each minute pays a tiny refresh cost (1–3 seconds) while the page pulls fresh data from the blockchain; everyone after that gets a cached version. Adding your own RPC key (free Alchemy) makes the refresh basically instant.",
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
    a: "No. The page works out of the box using free public RPCs. Adding your own free Alchemy URL makes things faster but isn't required at any traffic level a personal artist page sees.",
  },
  {
    q: "Which marketplaces are supported?",
    a: "Today: your own Sovereign Auction House. Foundation, SuperRare, and Transient Labs are on the roadmap and will surface automatically once added — no per-marketplace setup. Past sales appear from each.",
  },
  {
    q: "Can I use a custom domain?",
    a: "Yes. Both Vercel and Netlify let you connect any domain you own with one DNS record. Their docs walk you through it.",
  },
  {
    q: "Does this replace my profile in the main app?",
    a: "No. They coexist. The main app remains your discovery surface, your gallery, and your auction-creation tool. The artist site is your own page — the place you'd link in your bio.",
  },
  {
    q: "What happens when a marketplace upgrades their contract?",
    a: "You pull the latest version of this template and redeploy. We'll announce these when they happen. The deploy itself is the same one-click flow as the original setup.",
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
