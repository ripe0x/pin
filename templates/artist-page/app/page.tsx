import { ArtistHero } from "@/components/ArtistHero"
import { AuctionCard } from "@/components/AuctionCard"
import { Footer } from "@/components/Footer"
import { getAllAuctions, getArtistHouse } from "@/lib/auctions"

export const revalidate = 60

export default async function HomePage() {
  const [auctions, house] = await Promise.all([
    getAllAuctions(),
    getArtistHouse(),
  ])

  const active = auctions.filter(
    (a) => a.status === "live" || a.status === "upcoming",
  )
  const past = auctions.filter(
    (a) => a.status === "settled" || a.status === "cancelled",
  )

  return (
    <div className="mx-auto max-w-[2000px] px-6 py-12 space-y-12">
      <ArtistHero
        totalAuctions={auctions.length}
        activeAuctions={active.length}
      />

      {!house ? (
        <NoHouseState />
      ) : auctions.length === 0 ? (
        <EmptyState />
      ) : (
        <>
          {active.length > 0 ? (
            <Section label="Live">
              <Grid>
                {active.map((a) => (
                  <AuctionCard key={a.auctionId} auction={a} />
                ))}
              </Grid>
            </Section>
          ) : null}
          {past.length > 0 ? (
            <Section label="Past">
              <Grid>
                {past.map((a) => (
                  <AuctionCard key={a.auctionId} auction={a} />
                ))}
              </Grid>
            </Section>
          ) : null}
        </>
      )}

      <Footer />
    </div>
  )
}

function Section({
  label,
  children,
}: {
  label: string
  children: React.ReactNode
}) {
  return (
    <section className="space-y-4">
      <div className="flex items-center gap-2">
        <span className="h-1.5 w-1.5 rounded-full bg-gray-400" aria-hidden />
        <span className="text-[10px] font-mono uppercase tracking-wider text-gray-500">
          {label}
        </span>
      </div>
      {children}
    </section>
  )
}

function Grid({ children }: { children: React.ReactNode }) {
  // CSS multi-column masonry, matching PND's ArtistGallery. The
  // `[&>*]:break-inside-avoid` prevents a card from being split across
  // columns, and `[&>*]:mb-6` gives equivalent vertical rhythm to the
  // horizontal `gap-6`.
  return (
    <div className="columns-1 sm:columns-2 lg:columns-4 gap-6 [&>*]:mb-6 [&>*]:break-inside-avoid">
      {children}
    </div>
  )
}

function EmptyState() {
  return (
    <div className="border border-dashed border-gray-200 p-12 text-center">
      <p className="text-sm text-fg-muted">
        No auctions yet — they&rsquo;ll appear here once they&rsquo;re created on-chain.
      </p>
    </div>
  )
}

function NoHouseState() {
  return (
    <div className="border border-dashed border-gray-200 p-12 text-center space-y-2">
      <p className="text-sm font-medium">Auction house not deployed</p>
      <p className="text-sm text-fg-muted max-w-md mx-auto">
        This wallet hasn&rsquo;t deployed a Sovereign auction house yet. Deploy
        one in the main app, then auctions you create will show up here.
      </p>
    </div>
  )
}
