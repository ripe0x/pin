"use client"

// Pre-deploy homage landing for /collections/homage, rendered before the mainnet
// homage collection exists. Mirrors the live /collections/<address>?skin=homage
// sections (masthead, About, sample field, schedule, coming-soon mint) so the two
// states are visually continuous, but issues ZERO contract RPC: the sample field is
// generated locally from the per-trait color table (no SDK, no chain). Once the
// NEXT_PUBLIC_HOMAGE_* env vars are set, a rewrite serves the live page here instead.

import {useCallback, useEffect, useRef, useState, type ReactNode} from "react"
import Link from "next/link"
import {FitHeadline} from "./FitHeadline"
import {CrossfadeArt} from "@/components/mint/homage-gallery/CrossfadeArt"
import {useGeneratedArt, useGeneratedSample} from "./synthetic-punk"
import {weightedStatus} from "@/components/mint/homage-gallery/gallery-deck"
import {statusByCode} from "@/components/mint/homage-gallery/status"

const SUPPLY = 10_000
const META = "text-[10px] font-mono uppercase tracking-wider text-gray-400"
const POOL = 60 // seeds dealt; the layout uses however many fill the cell budget
const TARGET_CELL = 200 // 1× cell px; columns derive from width
const TARGET_ROWS = 6 // rows the wall fills; budget = cols × TARGET_ROWS
const GAP = 8
const SAMPLE_PX = 2000 // SVG intrinsic size, so copied/saved sample art is large

// A tile's desired span from its seed (stable across re-renders): ~72% 1×1, ~23%
// 2×2, ~5% 3×3. Clamped to the cell budget at layout time so the grid stays flush.
function desiredSpan(seed: number): number {
  let x = (seed ^ 0x9e3779b9) >>> 0
  x = Math.imul(x ^ (x >>> 16), 0x45d9f3b) >>> 0
  const r = ((x >>> 8) & 0xffffff) / 0xffffff
  return r < 0.05 ? 3 : r < 0.28 ? 2 : 1
}

// A synthetic sample: a seed (drives colors + ring structure) and a market ground.
type Sample = {seed: number; status: number}
type Tile = Sample & {key: number}

// About copy — the long-form record shown while there's no onchain contractURI to
// read. First block is the lead (no heading, the masthead already names the work).
const PC_LINK = "underline decoration-gray-500 underline-offset-2 hover:text-fg"
const ABOUT: {h: string | null; p: ReactNode[]}[] = [
  {
    h: null,
    p: [
      "Ten thousand generative artworks, one for every CryptoPunk. Each is composed from the punk’s onchain data and its live market state, rendered fully onchain.",
      "Each Homage reads directly from the official CryptoPunks data contract and uses that shared source as material for a new generative system. The work draws from the forms, colors, and attributes of the collection while producing an artwork of its own.",
      <>
        Every piece is backed by a fixed amount of{" "}
        <a href="https://permanentcollection.art/trade" target="_blank" rel="noopener noreferrer" className={PC_LINK}>
          $111
        </a>
        , redeemable in full at any time: burn the Homage to take the coins back out. Trading $111 feeds
        the{" "}
        <a href="https://permanentcollection.art" target="_blank" rel="noopener noreferrer" className={PC_LINK}>
          Permanent Collection
        </a>{" "}
        bid pool, an onchain protocol building a permanent collection of CryptoPunks, with one Punk for
        each of the 111 traits.
      </>,
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

// The mint windows, in order. Punk-owner claim and allowlist open together as one phase.
const WINDOWS = [
  {name: "Punk owner and allowlist", detail: "claim your id or enter the allowlist draw"},
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
                  <p
                    key={j}
                    className={
                      i === 0 && j === 0
                        ? "text-lg leading-relaxed text-fg sm:text-xl" // lead paragraph
                        : "text-sm leading-relaxed text-fg-muted"
                    }
                  >
                    {para}
                  </p>
                ))}
              </div>
            ))}
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

              {/* Mint schedule — the three windows, all upcoming until times are announced. */}
              <div className="space-y-3 rounded-lg border border-gray-200 bg-surface p-5">
                <h3 className={META}>Mint schedule</h3>
                <ul className="space-y-2.5">
                  {WINDOWS.map((w) => (
                    <li key={w.name} className="space-y-0.5">
                      <div className="flex items-baseline justify-between gap-3 text-[11px] font-mono">
                        <span className="flex items-center gap-2">
                          <span className="inline-block h-1.5 w-1.5 rounded-full bg-status-upcoming" />
                          <span className="text-fg">{w.name}</span>
                        </span>
                        <span className="shrink-0 text-gray-400">announced at launch</span>
                      </div>
                      <p className="pl-3.5 text-[10px] font-mono text-gray-500">{w.detail}</p>
                    </li>
                  ))}
                </ul>
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

// The sample wall: a quilt of synthetic homages (novel colors sampled from the
// collection's real ratios — no real punk), with a click-to-enlarge detail view.
// Regenerate re-deals fresh seeds. Every render is local — zero RPC.
function SampleWall() {
  const [tiles, setTiles] = useState<Tile[]>([])
  const [focusIdx, setFocusIdx] = useState<number | null>(null)
  const nextKey = useRef(0)

  const deal = useCallback(
    (): Tile[] =>
      Array.from(
        {length: POOL},
        (): Tile => ({
          seed: Math.floor(Math.random() * 0xffffffff),
          status: weightedStatus(),
          key: nextKey.current++,
        }),
      ),
    [],
  )

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
      <Quilt tiles={tiles} onFocus={setFocusIdx} />
      {focusIdx !== null && tiles.length > 0 && (
        <FocusOverlay
          samples={tiles}
          index={focusIdx}
          onNavigate={setFocusIdx}
          onClose={() => setFocusIdx(null)}
        />
      )}
    </div>
  )
}

function Quilt({tiles, onFocus}: {tiles: Tile[]; onFocus: (index: number) => void}) {
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
  // Varied sizes with a guaranteed flush bottom: pack tiles into an exact
  // TARGET_ROWS × cols grid. Scanning every cell row-major and placing a tile at
  // each still-free cell (a featured lead, then seed-derived spans, each shrunk to
  // the free space) covers every cell — so explicit positions fill a clean
  // rectangle with no holes and no ragged final row, at any width.
  const R = TARGET_ROWS
  const occ = Array.from({length: R}, () => new Array<boolean>(cols).fill(false))
  const placed: {tile: Tile; idx: number; r: number; c: number; span: number}[] = []
  let ti = 0
  for (let r = 0; r < R && ti < tiles.length; r++) {
    for (let c = 0; c < cols && ti < tiles.length; c++) {
      if (occ[r][c]) continue
      const tile = tiles[ti]
      const want = placed.length === 0 ? Math.min(3, cols - 1) : desiredSpan(tile.seed)
      let span = Math.min(want, R - r, cols - c)
      for (; span > 1; span--) {
        let free = true
        for (let dr = 0; dr < span && free; dr++)
          for (let dc = 0; dc < span; dc++) if (occ[r + dr][c + dc]) { free = false; break }
        if (free) break
      }
      for (let dr = 0; dr < span; dr++) for (let dc = 0; dc < span; dc++) occ[r + dr][c + dc] = true
      placed.push({tile, idx: ti, r, c, span})
      ti++
    }
  }

  return (
    <div ref={ref} style={{background: "var(--paper, #0a0a0c)"}}>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: `repeat(${cols}, ${track}px)`,
          gridTemplateRows: `repeat(${R}, ${track}px)`,
          gap: GAP,
          justifyContent: "center",
        }}
      >
        {placed.map(({tile, idx, r, c, span}) => (
          <WallTile
            key={tile.key}
            tile={tile}
            col={c + 1}
            row={r + 1}
            span={span}
            onFocus={() => onFocus(idx)}
          />
        ))}
      </div>
    </div>
  )
}

function WallTile({
  tile,
  col,
  row,
  span,
  onFocus,
}: {
  tile: Tile
  col: number
  row: number
  span: number
  onFocus: () => void
}) {
  const {src} = useGeneratedArt(tile.seed, tile.status, SAMPLE_PX)
  return (
    <button
      onClick={onFocus}
      aria-label="view this homage larger"
      className="relative block cursor-pointer overflow-hidden focus:outline-none focus-visible:ring-1 focus-visible:ring-white/50"
      style={{gridColumn: `${col} / span ${span}`, gridRow: `${row} / span ${span}`}}
    >
      <CrossfadeArt src={src} alt="a homage from the collection" />
    </button>
  )
}

// The generated homage large on its own ground, with its full trait list. ← / →
// step through the samples (wrapping); click the ground or Esc closes.
function FocusOverlay({
  samples,
  index,
  onNavigate,
  onClose,
}: {
  samples: Sample[]
  index: number
  onNavigate: (i: number) => void
  onClose: () => void
}) {
  const n = samples.length
  const sample = samples[index]
  const {src, traits: generated, colorCount} = useGeneratedSample(sample.seed, sample.status, SAMPLE_PX)
  const ground = statusByCode(sample.status).color
  const prev = () => onNavigate((index - 1 + n) % n)
  const next = () => onNavigate((index + 1) % n)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose()
      else if (e.key === "ArrowRight") onNavigate((index + 1) % n)
      else if (e.key === "ArrowLeft") onNavigate((index - 1 + n) % n)
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [onClose, onNavigate, index, n])

  const traits = generated
    ? [...generated, `${colorCount} colors`, statusByCode(sample.status).label].filter(Boolean)
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
      <button
        aria-label="close"
        onClick={(e) => {
          e.stopPropagation()
          onClose()
        }}
        className="absolute right-3 top-3 z-[61] flex h-11 w-11 items-center justify-center font-mono text-xl leading-none transition-opacity hover:opacity-100 sm:right-6 sm:top-5"
        style={{color: "rgba(255,255,255,0.7)", opacity: 0.6}}
      >
        ✕
      </button>
      <NavArrow side="left" onClick={prev} />
      <NavArrow side="right" onClick={next} />
      <div
        className="relative"
        onClick={(e) => e.stopPropagation()}
        style={{width: "min(72vmin, 720px)", aspectRatio: "1 / 1"}}
      >
        <CrossfadeArt src={src} alt="a homage from the collection" fadeMs={500} />
      </div>
      <div className="pointer-events-none absolute inset-x-0 bottom-0 flex flex-col items-center gap-2 px-6 pb-7 text-center">
        {traits.length > 0 && (
          <span
            className="max-w-[64ch] font-mono text-[11px] leading-relaxed tracking-[0.06em]"
            style={{color: "rgba(255,255,255,0.72)"}}
          >
            {traits.join(" · ")}
          </span>
        )}
        <span
          className="font-mono text-[10px] uppercase tracking-[0.18em]"
          style={{color: "rgba(255,255,255,0.4)"}}
        >
          ← → to browse · esc to close
        </span>
      </div>
    </div>
  )
}

function NavArrow({side, onClick}: {side: "left" | "right"; onClick: () => void}) {
  return (
    <button
      aria-label={side === "left" ? "previous homage" : "next homage"}
      onClick={(e) => {
        e.stopPropagation()
        onClick()
      }}
      className={`absolute top-1/2 -translate-y-1/2 ${side === "left" ? "left-3 sm:left-6" : "right-3 sm:right-6"} z-[61] flex h-11 w-11 items-center justify-center font-mono text-2xl leading-none transition-opacity hover:opacity-100`}
      style={{color: "rgba(255,255,255,0.7)", opacity: 0.6}}
    >
      {side === "left" ? "‹" : "›"}
    </button>
  )
}
