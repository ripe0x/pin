"use client"

// Pre-deploy homage landing for /collections/homage, rendered before the mainnet
// homage collection exists. Mirrors the live /collections/<address>?skin=homage
// sections (masthead, About, sample field, schedule, mint instrument) so the two
// states are visually continuous, but issues ZERO RPC: the sample field renders
// through the local punks SDK (no renderer contract), the schedule is the fixed
// window structure with no onchain timestamps, and the allowlist checker runs off
// the build's baked merkle proofs. Once the NEXT_PUBLIC_HOMAGE_* env vars are set
// the route redirects to the live page instead of rendering this.

import Link from "next/link"
import {FitHeadline} from "./FitHeadline"
import {AllowlistCheck} from "@/components/mint/homage-gallery/AllowlistCheck"
import {CrossfadeArt} from "@/components/mint/homage-gallery/CrossfadeArt"
import {useLocalArt} from "@/components/mint/homage-gallery/local"
import {STATUSES} from "@/components/mint/homage-gallery/status"

const SUPPLY = 10_000
const META = "text-[10px] font-mono uppercase tracking-wider text-gray-400"

// Deterministic sample spread across the 10k ids (SSR-safe — no Math.random),
// matching the live field's premint sample. Each cell takes one of the four
// market grounds in turn so the wall shows the full ground range.
const SAMPLE = Array.from({length: 24}, (_, i) => ({
  id: Math.floor((i + 0.5) * (SUPPLY / 24)),
  status: STATUSES[i % STATUSES.length].code,
}))

// The three windows, in order, with the same descriptions the live schedule uses.
// Times are announced at launch, so each row is upcoming with no timestamp.
const WINDOWS = [
  {name: "Punk owner claim", detail: "punk holders mint their own id"},
  {name: "Allowlist", detail: "random draw, flat fee"},
  {name: "Public", detail: "anyone, random draw"},
]

function SampleCell({id, status}: {id: number; status: number}) {
  const {src} = useLocalArt(id, status)
  return (
    <div className="relative aspect-square overflow-hidden bg-gray-100 dark:bg-bg">
      <CrossfadeArt src={src} alt="a homage from the collection" />
    </div>
  )
}

export function HomagePreview() {
  return (
    <div>
      {/* Masthead — the immersive chrome overlays the fixed 64px navbar, so pad clear of it. */}
      <header className="px-6 pb-8 pt-24 lg:px-12 lg:pb-10 lg:pt-32">
        <nav className="mb-8 text-[10px] font-mono uppercase tracking-wider text-gray-400 lg:mb-12">
          <Link href="/collections" className="hover:text-fg">
            ← Collections
          </Link>
        </nav>
        <div className="space-y-6">
          <FitHeadline text="Homage to the Punk" className="w-full" max={260} />
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-[11px] font-mono uppercase tracking-wider text-gray-500">
              one homage for every cryptopunk
            </p>
            <div className="flex items-center gap-3">
              <span className="inline-flex items-center gap-2 rounded-full border border-gray-200 px-3 py-1 text-[10px] font-mono uppercase tracking-wider text-gray-400">
                <span className="inline-block h-1.5 w-1.5 rounded-full bg-status-upcoming" />
                Minting soon
              </span>
              <p className="font-mono text-xl tabular-nums tracking-tight text-fg sm:text-2xl">
                0 <span className="text-gray-500">/ {SUPPLY.toLocaleString()}</span>
              </p>
            </div>
          </div>
        </div>
      </header>

      {/* Sample field — the collection's multiplicity, rendered locally. */}
      <div className="border-y border-gray-200">
        <div className="flex items-center justify-between px-6 py-3 lg:px-12">
          <span className={META}>Sample outputs</span>
        </div>
        <div
          className="grid gap-px"
          style={{
            gridTemplateColumns: "repeat(auto-fill, minmax(clamp(150px, 22vw, 300px), 1fr))",
            background: "var(--paper, #0a0a0c)",
          }}
        >
          {SAMPLE.map((s) => (
            <SampleCell key={s.id} id={s.id} status={s.status} />
          ))}
        </div>
      </div>

      {/* Editorial band: the story beside the coming-soon instrument. */}
      <div className="border-b border-gray-200">
        <div className="mx-auto grid w-full max-w-[1400px] grid-cols-1 lg:grid-cols-[1fr_556px] lg:divide-x lg:divide-gray-200">
          <div className="max-w-[720px] space-y-6 px-6 py-10 lg:px-12 lg:py-12">
            <h2 className={META}>About this work</h2>
            <p className="text-sm leading-relaxed text-fg-muted">
              Ten thousand generative artworks, one for every CryptoPunk. Each is composed from the
              punk&rsquo;s onchain data and its live market state, rendered fully onchain.
            </p>
            <p className="text-sm leading-relaxed text-fg-muted">
              Every piece is backed by 50,000 <span className="text-fg">$111</span> sealed inside,
              redeemable in full at any time: burn the homage to take the coins back out. Half of every
              fee feeds the Permanent Collection, a pool that buys real punks and holds them.
            </p>

            {/* Schedule — the three windows, all upcoming until times are announced. */}
            <div className="space-y-3 border-t border-gray-200 pt-6">
              <h3 className={META}>Mint schedule</h3>
              <ul className="space-y-2">
                {WINDOWS.map((w) => (
                  <li
                    key={w.name}
                    className="flex items-baseline justify-between gap-4 text-[11px] font-mono tabular-nums"
                  >
                    <span className="flex items-center gap-2">
                      <span className="inline-block h-1.5 w-1.5 rounded-full bg-status-upcoming" />
                      <span className="text-fg">{w.name}</span>
                      <span className="hidden text-gray-500 sm:inline">· {w.detail}</span>
                    </span>
                    <span className="shrink-0 text-gray-400">announced at launch</span>
                  </li>
                ))}
              </ul>
            </div>
          </div>

          <div className="mx-auto w-full max-w-[556px] px-6 py-10 lg:px-12 lg:py-12">
            <div className="mx-auto w-full max-w-[460px]">
              {/* Coming-soon instrument — the live mint card's shell in its not-yet-open state. */}
              <section className="space-y-3 border-b border-gray-100 py-5">
                <div className="overflow-hidden rounded-lg border border-gray-200 bg-surface">
                  <div className="space-y-4 p-5">
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-2">
                        <span className="inline-block h-1.5 w-1.5 rounded-full bg-status-upcoming" />
                        <span className="text-[10px] font-mono uppercase tracking-wider text-gray-500">
                          Not yet open
                        </span>
                      </div>
                      <span className="text-[10px] font-mono uppercase tracking-wider tabular-nums text-gray-400">
                        0 / {SUPPLY.toLocaleString()} minted
                      </span>
                    </div>
                    <div className="space-y-1">
                      <p className="text-[10px] font-mono uppercase tracking-wider text-gray-400">Opens</p>
                      <p className="text-sm font-mono text-gray-500">Coming soon</p>
                    </div>
                    <div className="pt-1">
                      <button
                        disabled
                        className="block w-full cursor-not-allowed bg-fg py-3 text-center text-[11px] font-mono font-medium uppercase tracking-wider text-bg opacity-40"
                      >
                        Minting soon
                      </button>
                    </div>
                  </div>
                </div>

                {/* Anyone can check any address against the allowlist during the teaser. */}
                <div className="rounded-lg border border-gray-200 bg-surface p-5">
                  <AllowlistCheck />
                </div>
              </section>
            </div>
          </div>
        </div>
      </div>

      {/* Record — the contract facts land once addresses are published. */}
      <section className="border-t border-gray-200">
        <div className="mx-auto max-w-[1400px] px-6 py-10 lg:px-12 lg:py-14">
          <p className={META}>Contract addresses published at launch.</p>
        </div>
      </section>
    </div>
  )
}
