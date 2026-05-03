/**
 * Vercel + Netlify "Deploy" buttons for the artist-page template repo.
 *
 * The two buttons sit side-by-side on desktop, stack on mobile. Both link
 * to their respective one-click deploy flows. The repo URL is centralized
 * here so we can update it in one place when the template moves out of the
 * monorepo into its own GitHub repo.
 */
import Image from "next/image"

// Public repo hosting the artist-page template. Update this when the
// template lands in its own repo.
const TEMPLATE_REPO_URL = "https://github.com/ripe0x/artist-auction-page"

const VERCEL_DEPLOY_URL =
  `https://vercel.com/new/clone?repository-url=${encodeURIComponent(TEMPLATE_REPO_URL)}` +
  `&env=NEXT_PUBLIC_ARTIST_ADDRESS` +
  `&envDescription=${encodeURIComponent("Your wallet address. Everything else (name, avatar, etc.) auto-resolves from your ENS profile.")}`

const NETLIFY_DEPLOY_URL =
  `https://app.netlify.com/start/deploy?repository=${encodeURIComponent(TEMPLATE_REPO_URL)}`

export function DeployButtons({ className = "" }: { className?: string }) {
  return (
    <div className={`flex flex-col sm:flex-row gap-3 ${className}`}>
      <a
        href={VERCEL_DEPLOY_URL}
        target="_blank"
        rel="noopener noreferrer"
        aria-label="Deploy with Vercel"
        className="inline-flex items-center justify-center gap-2 bg-fg text-bg text-sm font-medium px-5 py-3 hover:opacity-80 transition-opacity"
      >
        <Image
          src="https://vercel.com/button"
          alt=""
          width={92}
          height={32}
          unoptimized
          className="invert dark:invert-0"
        />
        <span>Deploy with Vercel</span>
      </a>
      <a
        href={NETLIFY_DEPLOY_URL}
        target="_blank"
        rel="noopener noreferrer"
        aria-label="Deploy to Netlify"
        className="inline-flex items-center justify-center gap-2 border border-gray-200 text-fg text-sm font-medium px-5 py-3 hover:border-gray-400 transition-colors"
      >
        <span>Deploy to Netlify</span>
      </a>
    </div>
  )
}

export { TEMPLATE_REPO_URL, VERCEL_DEPLOY_URL, NETLIFY_DEPLOY_URL }
