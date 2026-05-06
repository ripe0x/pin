/**
 * Async server component that renders the cached lifetime supporter
 * list for the FundingWorksRipe campaign as a small "Thank you.
 * Supported by:" block beneath the global footer's tagline row. Owns
 * its own lead line so the entire thank-you block disappears cleanly
 * when no supporters resolve (cold RPC outage, fresh deploy, etc.).
 *
 * Data is served from the two-layer cache; cold path (once per 24h
 * across all sandboxes) is a single `getLogs` + opportunistic ENS.
 */
import { getFundingWorksSupporters } from "@/lib/funding-works-supporters"
import { truncateAddress } from "./home/v2/format"

export async function SupportersList() {
  const supporters = await getFundingWorksSupporters()
  if (supporters.length === 0) return null

  return (
    <div>
      <p className="text-xs font-mono text-gray-500">
        Thank you. Supported by:
      </p>
      <ul className="mt-3 columns-2 sm:columns-3 md:columns-4 lg:columns-5 gap-x-6 text-xs font-mono leading-relaxed list-none p-0">
        {supporters.map((s) => (
          <li key={s.address} className="break-inside-avoid">
            <a
              href={`https://etherscan.io/address/${s.address}`}
              target="_blank"
              rel="noopener noreferrer"
              title={s.address}
              className={`block truncate transition-colors hover:underline ${
                s.ensName ? "text-gray-600" : "text-gray-500"
              }`}
            >
              {s.ensName ?? truncateAddress(s.address)}
            </a>
          </li>
        ))}
      </ul>
    </div>
  )
}
