import { ArtistHeader } from "@/components/ArtistHeader"
import { ArtistIntro } from "@/components/ArtistIntro"
import { AuctionCard } from "@/components/AuctionCard"
import { getAllAuctions, getArtistHouse } from "@/lib/auctions"

// ISR — re-render every 60s so live state stays current without re-running
// the full event scan on every visitor.
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
    <div className="min-h-screen">
      <ArtistHeader />
      <ArtistIntro />
      <main className="mx-auto max-w-5xl px-6 pb-20">
        {!house ? (
          <NoHouseState />
        ) : auctions.length === 0 ? (
          <EmptyState />
        ) : (
          <>
            {active.length > 0 ? (
              <Section title="Live">
                <Grid>
                  {active.map((a) => (
                    <AuctionCard key={a.auctionId} auction={a} />
                  ))}
                </Grid>
              </Section>
            ) : null}
            {past.length > 0 ? (
              <Section title="Past auctions">
                <Grid>
                  {past.map((a) => (
                    <AuctionCard key={a.auctionId} auction={a} />
                  ))}
                </Grid>
              </Section>
            ) : null}
          </>
        )}
      </main>
    </div>
  )
}

function Section({
  title,
  children,
}: {
  title: string
  children: React.ReactNode
}) {
  return (
    <section className="mt-10">
      <h2 className="mb-4 text-sm font-medium uppercase tracking-wider text-[hsl(var(--muted-foreground))]">
        {title}
      </h2>
      {children}
    </section>
  )
}

function Grid({ children }: { children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">
      {children}
    </div>
  )
}

function EmptyState() {
  return (
    <div className="mt-12 rounded-lg border border-dashed border-[hsl(var(--border))] p-12 text-center">
      <h3 className="text-lg font-medium">No auctions yet</h3>
      <p className="mt-2 text-sm text-[hsl(var(--muted-foreground))]">
        Auctions will appear here once they&apos;re created on-chain.
      </p>
    </div>
  )
}

function NoHouseState() {
  return (
    <div className="mt-12 rounded-lg border border-dashed border-[hsl(var(--border))] p-12 text-center">
      <h3 className="text-lg font-medium">Auction house not deployed</h3>
      <p className="mt-2 max-w-md text-sm text-[hsl(var(--muted-foreground))] mx-auto">
        This wallet hasn&apos;t deployed a Sovereign auction house yet. Deploy
        one in the main app, then auctions you create will show up here.
      </p>
    </div>
  )
}
