/**
 * Top hero block for the /sites landing page. Matches the H1 + mono
 * triplet pattern used on the home page (`HomeHeroTile`): a short
 * descriptor in Switzer above a three-line "your X." list in IBM Plex
 * Mono. The three beats name what the artist owns by running this
 * template, paralleling the home page's "your work / your contracts /
 * your fees" production-layer triplet — these are the distribution
 * layer (work shown on your URL to your collectors).
 *
 * No screenshot in the right column until real captures land in
 * apps/web/public/sites/. See that directory's README.
 */
import { DeployButtons } from "./DeployButtons"

export function Hero() {
  return (
    <section className="pt-12 pb-16 max-w-3xl">
      <div className="space-y-8">
        <div className="space-y-5">
          <h1 className="text-3xl sm:text-4xl font-semibold tracking-tight leading-tight">
            Run your own auction page.
          </h1>
          <ul className="space-y-1 font-mono text-base sm:text-lg font-medium text-gray-700 leading-snug">
            <li>your work.</li>
            <li>your URL.</li>
            <li>your collectors.</li>
          </ul>
        </div>
        <div className="space-y-2">
          <DeployButtons />
          <p className="text-[11px] font-mono uppercase tracking-wider text-gray-400 pt-2">
            Free to deploy · Two minutes · No backend
          </p>
        </div>
      </div>
    </section>
  )
}
