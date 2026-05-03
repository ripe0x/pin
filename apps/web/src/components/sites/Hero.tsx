/**
 * Top hero block for the /sites landing page. Headline + subhead on the
 * left, screenshot on the right (stacks on mobile). Mirrors the typography
 * scale used on the rest of the PND main app — no custom fonts, no extra
 * weight beyond what the theme already loads.
 */
import Image from "next/image"
import { DeployButtons } from "./DeployButtons"

export function Hero() {
  return (
    <section className="grid gap-12 lg:grid-cols-[1.2fr_1fr] items-center pt-12 pb-16">
      <div className="space-y-6">
        <h1 className="text-4xl sm:text-5xl font-semibold tracking-tight leading-[1.05]">
          Run your own auction page.
        </h1>
        <p className="text-base sm:text-lg text-fg-muted leading-relaxed max-w-prose">
          Self-hosted, brand-yours, free to run. Pulls every auction and
          sale from your wallet — straight from the blockchain — into one
          page on a domain you control.
        </p>
        <div className="space-y-2">
          <DeployButtons />
          <p className="text-[11px] font-mono uppercase tracking-wider text-gray-400 pt-2">
            Free to deploy · Two minutes · No backend
          </p>
        </div>
      </div>

      <div className="relative aspect-[4/3] w-full border border-gray-200 bg-gray-100 overflow-hidden">
        <Image
          src="/sites/screenshot-index.png"
          alt="Example artist auction page"
          fill
          sizes="(max-width: 1024px) 100vw, 50vw"
          className="object-cover"
          priority
        />
      </div>
    </section>
  )
}
