/**
 * Long-form prose block explaining the "why". Switzer body, comfortable
 * line-length, no list bullets here (the feature grid below handles that
 * pattern).
 */
export function WhyItExists() {
  return (
    <section className="py-16 border-t border-gray-200">
      <div className="grid gap-12 lg:grid-cols-[1fr_2fr]">
        <div>
          <p className="text-[11px] font-mono uppercase tracking-wider text-gray-500">
            Why
          </p>
          <h2 className="text-2xl sm:text-3xl font-semibold tracking-tight mt-2">
            Your auctions, your URL.
          </h2>
        </div>
        <div className="space-y-5 text-base text-fg-muted leading-relaxed max-w-prose">
          <p>
            Most artists today rely on marketplace pages owned by the
            marketplace. The marketplace decides what shows up there, what
            the URL looks like, and whether to keep it online next year.
            Your collectors land on a page that&apos;s mostly someone
            else&apos;s brand, with their controls in your way.
          </p>
          <p>
            An artist site is a single page on your own domain like{" "}
            <span className="font-mono text-fg">yourname.com/auctions</span>
            , reading directly from your Sovereign auction house contract.
            No middleman service, no scraping, no API key.
          </p>
          <p>
            Visitors connect their wallet and bid right there. Your settled
            auctions display as a permanent record. Link previews unfurl
            with the artwork and current bid, so when you share the page in
            any conversation it looks like it should.
          </p>
          <p>
            Free to host on Vercel or Netlify. The code is yours. Fork it,
            restyle it, replace the OG image, do whatever you want.
          </p>
        </div>
      </div>
    </section>
  )
}
