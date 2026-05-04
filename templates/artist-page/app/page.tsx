import { ArtistHero } from "@/components/ArtistHero"
import { AuctionCard, bucketFor } from "@/components/AuctionCard"
import { Footer } from "@/components/Footer"
import {
  getAllAuctions,
  getArtistHouse,
  type AuctionSummary,
} from "@/lib/auctions"

export const revalidate = 60

export default async function HomePage() {
  const [auctions, house] = await Promise.all([
    getAllAuctions(),
    getArtistHouse(),
  ])

  const active: AuctionSummary[] = []
  const ending: AuctionSummary[] = []
  const listed: AuctionSummary[] = []
  const past: AuctionSummary[] = []
  for (const a of auctions) {
    const bucket = bucketFor(a)
    if (bucket === "active") active.push(a)
    else if (bucket === "ending") ending.push(a)
    else if (bucket === "listed") listed.push(a)
    else past.push(a)
  }

  active.sort((a, b) => Number(a.endTime) - Number(b.endTime))
  ending.sort((a, b) => Number(a.endTime) - Number(b.endTime))
  listed.sort((a, b) => Number(b.auctionId) - Number(a.auctionId))

  const totalLive = active.length + ending.length

  return (
    <div className="mx-auto max-w-[2000px] px-6 py-12 space-y-12">
      <ArtistHero
        totalAuctions={auctions.length}
        activeAuctions={totalLive}
      />

      {!house ? (
        <NoHouseState />
      ) : auctions.length === 0 ? (
        <EmptyState />
      ) : (
        <>
          {active.length > 0 ? (
            <Section label="Active" dotClass="bg-status-live">
              <Grid>
                {active.map((a) => (
                  <AuctionCard key={a.auctionId} auction={a} />
                ))}
              </Grid>
            </Section>
          ) : null}
          {ending.length > 0 ? (
            <Section label="Ending" dotClass="bg-status-upcoming">
              <Grid>
                {ending.map((a) => (
                  <AuctionCard key={a.auctionId} auction={a} />
                ))}
              </Grid>
            </Section>
          ) : null}
          {listed.length > 0 ? (
            <Section label="Listed" dotClass="bg-gray-400">
              <Grid>
                {listed.map((a) => (
                  <AuctionCard key={a.auctionId} auction={a} />
                ))}
              </Grid>
            </Section>
          ) : null}
          {past.length > 0 ? (
            <Section label="Past" dotClass="bg-gray-400">
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
  dotClass,
  children,
}: {
  label: string
  dotClass: string
  children: React.ReactNode
}) {
  return (
    <section className="space-y-4">
      <div className="flex items-center gap-2">
        <span
          className={`h-1.5 w-1.5 rounded-full ${dotClass}`}
          aria-hidden
        />
        <span className="text-[10px] font-mono uppercase tracking-wider text-gray-500">
          {label}
        </span>
      </div>
      {children}
    </section>
  )
}

function Grid({ children }: { children: React.ReactNode }) {
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
