/**
 * Deploy buttons for the artist-page template.
 *
 * Vercel sits on top as the recommended one-click path: their deploy
 * button creates a real GitHub fork, so future updates to the template
 * propagate via GitHub's "Sync fork" with no terminal involvement.
 *
 * Netlify's deploy button (intentionally) creates a *standalone* repo
 * with no upstream link, which means non-technical artists have no path
 * to pull future updates without using git on the command line. So the
 * Netlify path here is split into two steps — fork on GitHub, then
 * import the fork into Netlify — which preserves the upstream link and
 * makes "Sync fork" work the same way Vercel does. Two clicks, but
 * every future update lands without leaving the browser.
 */
import Image from "next/image"

const TEMPLATE_REPO_URL = "https://github.com/ripe0x/sovereign-artist-site"

const VERCEL_DEPLOY_URL =
  `https://vercel.com/new/clone?repository-url=${encodeURIComponent(TEMPLATE_REPO_URL)}` +
  `&env=NEXT_PUBLIC_ARTIST_ADDRESS` +
  `&envDescription=${encodeURIComponent("Your wallet address. Everything else (name, avatar, etc.) auto-resolves from your ENS profile.")}`

const GITHUB_FORK_URL = `${TEMPLATE_REPO_URL}/fork`
const NETLIFY_IMPORT_URL = "https://app.netlify.com/start"

export function DeployButtons({
  className = "",
  artistAddress,
}: {
  className?: string
  artistAddress?: string
}) {
  return (
    <div className={`space-y-5 ${className}`}>
      {artistAddress && (
        <div className="flex items-center gap-2 font-mono text-xs bg-gray-50 border border-gray-200 px-3 py-2 rounded">
          <span className="text-gray-400 shrink-0">NEXT_PUBLIC_ARTIST_ADDRESS</span>
          <span className="text-gray-700 truncate">{artistAddress}</span>
        </div>
      )}
      <div>
        <a
          href={VERCEL_DEPLOY_URL}
          target="_blank"
          rel="noopener noreferrer"
          aria-label="Deploy with Vercel"
          className="inline-flex items-center justify-center gap-2 bg-fg text-bg text-[11px] font-mono font-medium uppercase tracking-wider px-5 py-3 hover:opacity-80 transition-opacity"
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
        <p className="text-[11px] font-mono uppercase tracking-wider text-gray-400 pt-2">
          Recommended · One click · Updates via GitHub Sync fork
        </p>
      </div>

      <div>
        <p className="text-[11px] font-mono uppercase tracking-wider text-gray-500">
          Or use Netlify (two steps)
        </p>
        <div className="flex flex-col sm:flex-row gap-3 pt-3">
          <a
            href={GITHUB_FORK_URL}
            target="_blank"
            rel="noopener noreferrer"
            aria-label="Step 1: fork on GitHub"
            className="inline-flex items-center justify-center gap-2 border border-gray-200 text-fg text-sm font-medium px-5 py-3 hover:border-gray-400 transition-colors"
          >
            <span>1. Fork on GitHub</span>
          </a>
          <a
            href={NETLIFY_IMPORT_URL}
            target="_blank"
            rel="noopener noreferrer"
            aria-label="Step 2: deploy your fork on Netlify"
            className="inline-flex items-center justify-center gap-2 border border-gray-200 text-fg text-sm font-medium px-5 py-3 hover:border-gray-400 transition-colors"
          >
            <span>2. Deploy your fork on Netlify</span>
          </a>
        </div>
        <p className="text-[11px] font-mono uppercase tracking-wider text-gray-400 pt-2">
          Two clicks · Pick your fork in step 2 · Set <span className="normal-case tracking-normal font-mono">NEXT_PUBLIC_ARTIST_ADDRESS</span> in Netlify env vars
        </p>
      </div>
    </div>
  )
}

export {
  TEMPLATE_REPO_URL,
  VERCEL_DEPLOY_URL,
  GITHUB_FORK_URL,
  NETLIFY_IMPORT_URL,
}
