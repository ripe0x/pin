import { HomeEntryPoints } from "./HomeEntryPoints"

/**
 * The hero, rendered as a tile in the home-page grid rather than a banner
 * above it. Same form factor as work / artist tiles (border, gray-200,
 * no hover affordance — it's a container, not a click target). Spans two
 * columns on desktop so it has room to breathe alongside the square.
 *
 * Search lives in the navbar on every viewport; the wallet sits in the
 * navbar's connect button. The hero is purely editorial: where you are,
 * what you can do.
 */
export function HomeHeroTile() {
  return (
    <div className="border border-gray-200 p-6 lg:p-8 flex flex-col justify-between gap-8 h-full lg:min-h-[359px]">
      <div className="space-y-5">
        <h1 className="text-2xl md:text-3xl font-semibold tracking-tight leading-tight max-w-md">
          artist infrastructure on Ethereum
        </h1>
        <ul className="space-y-1 font-mono text-base md:text-lg font-medium text-gray-700 leading-snug">
          <li>your work.</li>
          <li>your contracts.</li>
          <li>your fees.</li>
        </ul>
      </div>

      <HomeEntryPoints />
    </div>
  )
}
