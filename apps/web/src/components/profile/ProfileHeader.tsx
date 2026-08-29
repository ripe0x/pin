import type { ArtistIdentity } from "@/lib/artist-queries"
import type { ProfileSummary } from "@/lib/profile-queries"
import { AddressZorb } from "@/components/AddressZorb"
import { CopyAddressButton } from "@/components/CopyAddressButton"

export function ProfileHeader({
  identity,
  summary,
}: {
  identity: ArtistIdentity
  summary: ProfileSummary
}) {
  const truncated = `${identity.address.slice(0, 6)}…${identity.address.slice(-4)}`
  const explorer = `https://evm.now/address/${identity.address}`

  return (
    <header className="space-y-6">
      <div className="flex flex-col gap-5 sm:flex-row sm:items-center">
        {identity.avatarUrl ? (
          <img
            src={identity.avatarUrl}
            alt=""
            className="h-20 w-20 shrink-0 rounded-full object-cover"
          />
        ) : (
          <AddressZorb address={identity.address} className="h-20 w-20 shrink-0 rounded-full" />
        )}

        <div className="min-w-0 space-y-2">
          <h1 className="truncate font-mono text-base font-medium tracking-tight">
            {identity.displayName}
          </h1>
          <div className="flex items-center gap-2">
            <a
              href={explorer}
              target="_blank"
              rel="noopener noreferrer"
              className="font-mono text-[11px] text-gray-500 hover:text-fg"
            >
              {truncated}
            </a>
            <CopyAddressButton address={identity.address} />
          </div>
          <div className="flex flex-wrap gap-1.5">
            {summary.roles.length > 0 ? summary.roles.map((role) => (
              <span
                key={role}
                className="rounded-full border border-gray-200 px-2 py-1 font-mono text-[10px] capitalize text-gray-600"
              >
                {role}
              </span>
            )) : (
              <span className="font-mono text-[10px] text-gray-500">
                No role inferred from indexed evidence yet
              </span>
            )}
          </div>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-px overflow-hidden border border-gray-200 bg-gray-200 sm:grid-cols-4">
        <ProfileStat label="created" value={summary.createdTotal} />
        <ProfileStat
          label={summary.openReleaseTotal > 0 ? "open releases + listings" : "available"}
          value={summary.availableTotal}
        />
        <ProfileStat label="currently held" value={summary.heldTotal} />
        <ProfileStat label="Catalog declarations" value={summary.declaredTotal} />
      </div>

      <div className="border-l-2 border-gray-200 pl-3 text-xs leading-relaxed text-gray-500">
        <p>{summary.coverageNote}</p>
        {(summary.surfaceCount > 0 || summary.auctionHouseCount > 0) && (
          <p className="mt-1 text-gray-700">
            Artist-owned infrastructure: {summary.surfaceCount} Surface {summary.surfaceCount === 1 ? "collection" : "collections"}
            {summary.auctionHouseCount > 0
              ? ` · ${summary.auctionHouseCount} PND auction ${summary.auctionHouseCount === 1 ? "house" : "houses"}`
              : ""}.
          </p>
        )}
      </div>
    </header>
  )
}

function ProfileStat({ label, value }: { label: string; value: number }) {
  return (
    <div className="bg-bg px-3 py-3">
      <strong className="block font-mono text-sm font-medium text-fg">{value}</strong>
      <span className="font-mono text-[10px] text-gray-500">{label}</span>
    </div>
  )
}
