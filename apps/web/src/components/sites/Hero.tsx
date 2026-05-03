/**
 * Top hero block for the /sites landing page. The mono list echoes the
 * home page's "your work / your contracts / your fees" triplet exactly,
 * then adds a fourth beat ("now, your url.") that names the new layer
 * this template provides. Reinforces the framing: PND already covers
 * the production layer; this is the distribution layer on top.
 *
 * No screenshot in the right column until real captures land in
 * apps/web/public/sites/.
 */
import { DeployButtons } from "./DeployButtons"

export function Hero() {
  return (
    <section className="pt-12 pb-16 max-w-3xl">
      <div className="space-y-8">
        <div className="space-y-5">
          <h1 className="text-3xl sm:text-4xl font-semibold tracking-tight leading-tight">
            Run your own auctions, on your own url.
          </h1>
          <ul className="space-y-1 font-mono text-base sm:text-lg font-medium text-gray-700 leading-snug">
            <li>your work.</li>
            <li>your contracts.</li>
            <li>your fees.</li>
            <li>now, your url.</li>
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
