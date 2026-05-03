/**
 * Three captioned screenshots showing the deployed template's actual
 * pages. Real images live at `apps/web/public/sites/`. The screenshots
 * should be captured from a live deployment of the template (we tested
 * with `ripe0x.eth` during development).
 *
 * If a screenshot file is missing, Next will return a 404 and the
 * `<img>` tag falls back to its alt text — the page degrades gracefully.
 */
import Image from "next/image"

const shots = [
  {
    src: "/sites/screenshot-index.png",
    title: "The index page",
    caption:
      "Masonry grid of every active and past auction. Live ones are pinned to the top with countdowns. Past ones show the final sale price.",
    aspect: "aspect-[4/3]",
  },
  {
    src: "/sites/screenshot-detail.png",
    title: "An auction page",
    caption:
      "Sticky artwork on the left, scrolling sidebar on the right. Bid form, current price, bid history, all live and all in-page.",
    aspect: "aspect-[16/10]",
  },
  {
    src: "/sites/screenshot-unfurl.png",
    title: "Link previews",
    caption:
      "Share an auction link in Twitter, Farcaster, Discord, or iMessage. The artwork and current bid render right in the unfurl.",
    aspect: "aspect-[16/10]",
  },
]

export function ScreenshotsGallery() {
  return (
    <section className="py-16 border-t border-gray-200">
      <div className="space-y-12">
        <div>
          <p className="text-[11px] font-mono uppercase tracking-wider text-gray-500">
            What it looks like
          </p>
          <h2 className="text-2xl sm:text-3xl font-semibold tracking-tight mt-2">
            Built to match your work, not the marketplace&apos;s.
          </h2>
        </div>
        <div className="space-y-12">
          {shots.map((s) => (
            <figure key={s.src} className="space-y-4">
              <div
                className={`relative ${s.aspect} w-full border border-gray-200 bg-gray-100 overflow-hidden`}
              >
                <Image
                  src={s.src}
                  alt={s.title}
                  fill
                  sizes="(max-width: 1024px) 100vw, 80vw"
                  className="object-cover"
                />
              </div>
              <figcaption className="grid gap-2 sm:grid-cols-[200px_1fr] sm:gap-8">
                <p className="text-[11px] font-mono uppercase tracking-wider text-gray-500">
                  {s.title}
                </p>
                <p className="text-sm text-fg-muted leading-relaxed max-w-prose">
                  {s.caption}
                </p>
              </figcaption>
            </figure>
          ))}
        </div>
      </div>
    </section>
  )
}
