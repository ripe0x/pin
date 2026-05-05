import { unstable_noStore as noStore } from "next/cache"
import { getActivityFeed } from "@/lib/indexer-queries"
import { getArtistIdentity } from "@/lib/artist-queries"
import { ActivityRow } from "./ActivityRow"
import { truncateAddress } from "./format"

const FEED_SIZE = 50

/**
 * Server-side feed: pulls the unioned event stream from the indexer,
 * resolves every unique artist's identity (cached, so each unique
 * address is one ENS pair), and renders a list of ActivityRow.
 *
 * If the indexer is unavailable / disabled we render an empty state
 * rather than the rest of the page disappearing.
 */
export async function ActivityFeed() {
  noStore()

  const events = await getActivityFeed(FEED_SIZE)

  if (!events) {
    return (
      <p className="font-mono text-xs text-gray-400 italic py-12 text-center">
        feed temporarily unavailable
      </p>
    )
  }

  if (events.length === 0) {
    return (
      <p className="font-mono text-xs text-gray-400 italic py-12 text-center">
        no activity yet
      </p>
    )
  }

  const uniqueArtists = Array.from(
    new Set(events.map((e) => e.artist.toLowerCase())),
  )
  const identities = new Map(
    await Promise.all(
      uniqueArtists.map(
        async (addr) =>
          [addr, await getArtistIdentity(addr).catch(() => null)] as const,
      ),
    ),
  )

  return (
    <ul className="border-b border-gray-200">
      {events.map((event) => {
        const id = identities.get(event.artist.toLowerCase())
        return (
          <ActivityRow
            key={event.id}
            event={event}
            artistDisplayName={
              id?.displayName ?? truncateAddress(event.artist)
            }
            artistAvatarUrl={id?.avatarUrl ?? null}
          />
        )
      })}
    </ul>
  )
}
