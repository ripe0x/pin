"use client"

// Pre-deploy homage landing for /collections/homage, rendered before the mainnet
// homage collection exists. Mirrors the live /collections/<address>?skin=homage
// sections (masthead, About, sample field, schedule, mint instrument) so the two
// states are visually continuous, but issues ZERO contract RPC: the sample field
// renders through the local punks SDK, the allowlist checker runs off the build's
// baked merkle proofs, and the reservation form captures to Netlify Forms. Once
// the NEXT_PUBLIC_HOMAGE_* env vars are set the route redirects to the live page
// instead of rendering this.

import {useCallback, useEffect, useRef, useState} from "react"
import Link from "next/link"
import {FitHeadline} from "./FitHeadline"
import {HomageReservation} from "./HomageReservation"
import {AllowlistCheck} from "@/components/mint/homage-gallery/AllowlistCheck"
import {CrossfadeArt} from "@/components/mint/homage-gallery/CrossfadeArt"
import {useLocalArt, useLocalSample} from "@/components/mint/homage-gallery/local"
import {makeDealer, randomSpan, type Piece} from "@/components/mint/homage-gallery/gallery-deck"
import {accessories, trait} from "@/components/mint/homage-gallery/svg"
import {statusByCode} from "@/components/mint/homage-gallery/status"

const SUPPLY = 10_000
const META = "text-[10px] font-mono uppercase tracking-wider text-gray-400"
const DEAL = 28 // sample tiles per grid
const TARGET_CELL = 200 // desired 1×1 cell px; columns derive from width
const GAP = 8

type Tile = Piece & {span: number; key: number}

// About copy — the long-form record shown while there's no onchain contractURI to
// read. First block is the lead (no heading, the masthead already names the work).
const ABOUT: {h: string | null; p: string[]}[] = [
  {
    h: null,
    p: [
      "Ten thousand generative artworks, one for every CryptoPunk. Each is composed from the punk’s onchain data and its live market state, rendered fully onchain.",
      "Every piece is backed by a fixed amount of $111, redeemable in full at any time: burn the homage to take the coins back out. Half of every fee feeds the Permanent Collection, a pool that buys real punks and holds them.",
      "Each Homage reads directly from the official CryptoPunks data contract and uses that shared source as material for a new generative system. The work draws from the forms, colors, and attributes of the collection while producing an artwork of its own.",
      "The entire collection lives on Ethereum. The code, metadata, source data, and rendered artwork are all onchain. No hosted image server, external metadata service, or offchain renderer is required for a Homage to exist.",
    ],
  },
  {
    h: "Minting",
    p: [
      "Each mint purchases a fixed amount of $111 at the current market price and places it inside the newly minted Homage token.",
      "The cost of those tokens changes with the market, so the mint price moves with the price of $111. A flat mint fee is also included in the cost of the purchase.",
      "Each Homage therefore contains a fixed amount of $111, even though the ETH value of that amount may change over time.",
    ],
  },
  {
    h: "Permanent Collection",
    p: [
      "$111 is connected to Permanent Collection, a protocol designed to acquire one CryptoPunk for each of the 111 official traits and hold those Punks permanently in a public onchain vault.",
      "Trading $111 contributes ETH to the Permanent Collection bid pool through the token’s trading fees. A portion of the mint fee from every Homage mint also goes directly to the bid pool.",
      "Minting Homage creates an onchain artwork, purchases $111 from the market, and contributes to Permanent Collection’s attempt to acquire and permanently hold Punks.",
    ],
  },
  {
    h: "Redemption",
    p: [
      "A Homage holder may redeem the $111 held inside their token at any time.",
      "Redeeming transfers the full redeemed $111 balance to the holder and burns the Homage. That position in the 10,000 token collection then becomes available for anyone to mint again at the current price.",
      "The artwork can remain held as a Homage or be returned to the system for the $111 inside it.",
    ],
  },
]

// The three windows, in order, with the same descriptions the live schedule uses.
const WINDOWS = [
  {name: "Punk owner claim", detail: "punk holders mint their own id"},
  {name: "Allowlist", detail: "random draw, flat fee"},
  {name: "Public", detail: "anyone, random draw"},
]

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
            <p className="text-[11px] font-mono uppercase tracking-wider text-gray-500">by ripe</p>
            <span className="inline-flex items-center gap-2 rounded-full border border-gray-200 px-3 py-1 text-[10px] font-mono uppercase tracking-wider text-gray-400">
              <span className="inline-block h-1.5 w-1.5 rounded-full bg-status-upcoming" />
              Minting soon
            </span>
          </div>
        </div>
      </header>

      {/* Sample field — the collection's multiplicity, rendered locally. */}
      <SampleWall />

      {/* Editorial band: the record beside the coming-soon instrument. */}
      <div className="border-b border-gray-200">
        <div className="mx-auto grid w-full max-w-[1400px] grid-cols-1 lg:grid-cols-[1fr_556px] lg:divide-x lg:divide-gray-200">
          <div className="max-w-[720px] space-y-8 px-6 py-10 lg:px-12 lg:py-12">
            <h2 className={META}>About this work</h2>
            {ABOUT.map((s, i) => (
              <div key={i} className="space-y-4">
                {s.h && (
                  <h3 className="text-sm font-medium tracking-tight text-fg">{s.h}</h3>
                )}
                {s.p.map((para, j) => (
                  <p key={j} className="text-sm leading-relaxed text-fg-muted">
                    {para}
                  </p>
                ))}
              </div>
            ))}

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
            <div className="mx-auto w-full max-w-[460px] space-y-6">
              {/* Coming-soon instrument — the live mint card's shell in its not-yet-open state. */}
              <section className="overflow-hidden rounded-lg border border-gray-200 bg-surface">
                <div className="space-y-4 p-5">
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <span className="inline-block h-1.5 w-1.5 rounded-full bg-status-upcoming" />
                      <span className="text-[10px] font-mono uppercase tracking-wider text-gray-500">
                        Not yet open
                      </span>
                    </div>
                    <span className="text-[10px] font-mono uppercase tracking-wider tabular-nums text-gray-400">
                      {SUPPLY.toLocaleString()} to mint
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
              </section>

              {/* Punk holders (held or delegated) reserve their id ahead of launch. */}
              <HomageReservation />

              {/* Anyone can check any address against the allowlist during the teaser.
                  Purely client-side against the baked merkle proofs — no wallet, no RPC. */}
              <div className="rounded-lg border border-gray-200 bg-surface p-5">
                <p className="mb-3 text-[10px] font-mono uppercase tracking-wider text-gray-400">Allowlist</p>
                <AllowlistCheck />
              </div>
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

// The sample wall: a deck-dealt quilt of locally-rendered homages, withheld ids, a
// featured lead cell, and a click-to-enlarge detail view. Regenerate re-deals a
// fresh spread. Every render is local (punks SDK) — zero RPC.
function SampleWall() {
  const [tiles, setTiles] = useState<Tile[]>([])
  const [focus, setFocus] = useState<Piece | null>(null)
  const nextKey = useRef(0)

  const deal = useCallback((): Tile[] => {
    const draw = makeDealer()
    return Array.from({length: DEAL}, (): Tile => ({...draw(), span: randomSpan(), key: nextKey.current++}))
  }, [])

  // First deal is client-side only (Math.random), never during SSR render.
  useEffect(() => setTiles(deal()), [deal])

  return (
    <div className="border-y border-gray-200">
      <div className="flex items-center justify-between px-6 py-3 lg:px-12">
        <span className={META}>Sample outputs</span>
        <button
          onClick={() => setTiles(deal())}
          className="text-[10px] font-mono uppercase tracking-wider text-gray-400 transition-colors hover:text-fg"
        >
          ↻ Regenerate
        </button>
      </div>
      <Quilt tiles={tiles} onFocus={setFocus} />
      {focus && <FocusOverlay piece={focus} onClose={() => setFocus(null)} />}
    </div>
  )
}

function Quilt({tiles, onFocus}: {tiles: Tile[]; onFocus: (p: Piece) => void}) {
  const [width, setWidth] = useState(0)
  const ref = useCallback((el: HTMLDivElement | null) => {
    if (!el) return
    setWidth(el.clientWidth)
    if (typeof ResizeObserver !== "undefined") {
      const ro = new ResizeObserver(() => setWidth(el.clientWidth))
      ro.observe(el)
    }
  }, [])
  const cols = Math.max(3, Math.floor((width + GAP) / (TARGET_CELL + GAP)))
  const track = width ? (width - GAP * (cols - 1)) / cols : TARGET_CELL

  return (
    <div ref={ref} style={{background: "var(--paper, #0a0a0c)"}}>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: `repeat(${cols}, ${track}px)`,
          gridAutoRows: `${track}px`,
          gridAutoFlow: "dense",
          gap: GAP,
          justifyContent: "center",
        }}
      >
        {tiles.map((t, i) => (
          <WallTile
            key={t.key}
            tile={t}
            maxSpan={cols}
            featured={i === 0 && tiles.length >= 5}
            onFocus={() => onFocus({id: t.id, status: t.status})}
          />
        ))}
      </div>
    </div>
  )
}

function WallTile({
  tile,
  maxSpan,
  featured,
  onFocus,
}: {
  tile: Tile
  maxSpan: number
  featured: boolean
  onFocus: () => void
}) {
  const {src} = useLocalArt(tile.id, tile.status)
  const span = Math.min(featured ? Math.max(tile.span, 2) : tile.span, maxSpan)
  return (
    <button
      onClick={onFocus}
      aria-label="view this homage larger"
      className="relative block cursor-pointer overflow-hidden focus:outline-none focus-visible:ring-1 focus-visible:ring-white/50"
      style={{gridColumn: `span ${span}`, gridRow: `span ${span}`}}
    >
      <CrossfadeArt src={src} alt="a homage from the collection" />
    </button>
  )
}

// The work large on its own ground, with its traits but never its number (which
// punk it is stays the draw). Click or Esc closes.
function FocusOverlay({piece, onClose}: {piece: Piece; onClose: () => void}) {
  const {src, meta} = useLocalSample(piece.id, piece.status)
  const ground = statusByCode(piece.status).color

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose()
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [onClose])

  const traits = meta
    ? [
        trait(meta, "Punk Type"),
        ...accessories(meta),
        `${trait(meta, "Color Count")} colors`,
        statusByCode(piece.status).label,
      ].filter(Boolean)
    : []

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="a homage from the collection, shown large"
      onClick={onClose}
      className="fixed inset-0 z-[60] flex cursor-pointer flex-col items-center justify-center"
      style={{background: ground, transition: "background-color 600ms ease"}}
    >
      <div
        className="relative"
        onClick={(e) => e.stopPropagation()}
        style={{width: "min(72vmin, 720px)", aspectRatio: "1 / 1"}}
      >
        <CrossfadeArt src={src} alt="a homage from the collection" fadeMs={500} />
      </div>
      <div className="pointer-events-none absolute inset-x-0 bottom-0 flex flex-col items-center gap-2 px-6 pb-7 text-center">
        <span
          className="font-mono text-[11px] uppercase tracking-[0.22em]"
          style={{color: "rgba(255,255,255,0.9)"}}
        >
          one of ten thousand
        </span>
        {traits.length > 0 && (
          <span
            className="max-w-[64ch] font-mono text-[11px] leading-relaxed tracking-[0.06em]"
            style={{color: "rgba(255,255,255,0.72)"}}
          >
            {traits.join(" · ")}
          </span>
        )}
      </div>
    </div>
  )
}
