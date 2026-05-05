"use client"

import { useEffect, useState } from "react"
import { useAccount } from "wagmi"
import { DeployButtons } from "./DeployButtons"

/**
 * Shown only to the connected wallet owner on their own artist page.
 * Reads the artist's ENS `url` text record to determine deployment state:
 *   - URL found → display a link to their live site (deploy buttons hidden)
 *   - No URL     → display Vercel/Netlify deploy buttons with the artist's
 *                  address pre-filled in the Vercel env var prompt
 */
export function SitePanel({ artistAddress }: { artistAddress: string }) {
  const { address: connected } = useAccount()
  const isOwner =
    !!connected && connected.toLowerCase() === artistAddress.toLowerCase()

  // undefined = still fetching, null = no URL found, string = URL found
  const [siteUrl, setSiteUrl] = useState<string | null | undefined>(undefined)

  useEffect(() => {
    if (!isOwner) return
    let cancelled = false
    fetch(`/api/artist/${artistAddress}/ens-url`)
      .then((r) => r.json())
      .then(({ url }: { url: string | null }) => {
        if (!cancelled) setSiteUrl(url ?? null)
      })
      .catch(() => {
        if (!cancelled) setSiteUrl(null)
      })
    return () => {
      cancelled = true
    }
  }, [isOwner, artistAddress])

  if (!isOwner) return null
  // Don't flash the panel while the ENS lookup is in-flight.
  if (siteUrl === undefined) return null

  if (siteUrl) {
    return (
      <div className="rounded-lg border border-gray-200 bg-surface p-5 flex items-center justify-between gap-4">
        <div>
          <p className="text-sm font-semibold text-gray-900">Your artist site</p>
          <a
            href={siteUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs text-gray-500 hover:underline break-all"
          >
            {siteUrl} ↗
          </a>
        </div>
        <a
          href={siteUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="shrink-0 text-xs border border-gray-200 px-3 py-1.5 rounded-full hover:border-gray-400 transition-colors"
        >
          Visit ↗
        </a>
      </div>
    )
  }

  return (
    <div className="rounded-lg border border-gray-200 bg-surface p-5">
      <h2 className="text-sm font-semibold text-gray-900">
        Launch your own artist site
      </h2>
      <p className="text-xs text-gray-500 mt-1 mb-5 leading-relaxed">
        Deploy a standalone site from the open-source template — no code
        required. Your address is pre-filled; just connect Vercel or Netlify
        and deploy.
      </p>
      <DeployButtons artistAddress={artistAddress} />
      <p className="text-[11px] font-mono uppercase tracking-wider text-gray-400 mt-5">
        Once deployed, set your site URL in your ENS profile&rsquo;s{" "}
        <span className="normal-case tracking-normal font-mono">url</span> field
        and it will appear here automatically.
      </p>
    </div>
  )
}
