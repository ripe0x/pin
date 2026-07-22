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
import {HomageAllowlistLookup} from "./HomageAllowlistLookup"
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
const ART = "/homage/article" // inline media, copied from the article asset build

// A section is a heading and an ordered list of blocks: paragraphs, a lead, a bold
// sub-label, a bullet list, or an inline media figure. Media files live under ART.
type Block =
  | {t: "lead"; node: ReactNode}
  | {t: "p"; node: ReactNode}
  | {t: "sub"; text: string}
  | {t: "list"; items: ReactNode[]}
  | {t: "media"; src: string; alt: string; caption?: string}

const ABOUT: {h: string | null; blocks: Block[]}[] = [
  {
    h: null,
    blocks: [
      {
        t: "lead",
        node: "Ten thousand generative artworks, one for every CryptoPunk. Each is composed from the punk’s onchain data and its live market state, rendered fully onchain.",
      },
      {t: "p", node: "One system applied across all 10,000 Punks."},
      {
        t: "media",
        src: "pair-16-512px.gif",
        alt: "Animated pairs of CryptoPunks beside the Homage artwork generated from each.",
      },
    ],
  },
  {
    h: "One structure, 10,000 palettes",
    blocks: [
      {
        t: "p",
        node: (
          <>
            Homage takes its name and structure from Josef Albers’s <em>Homage to the Square</em>.
          </>
        ),
      },
      {
        t: "p",
        node: "Albers kept the composition fixed and changed the relationships between colors. Homage uses the same method across CryptoPunks.",
      },
      {t: "p", node: "The geometry remains consistent."},
      {t: "p", node: "Every Punk supplies a different palette."},
      {
        t: "p",
        node: "The renderer reads the colors in the source Punk, measures how much of each color appears, and arranges the result into nested fields, one ring for every distinct color.",
      },
      {t: "p", node: "The same Punk always produces the same central composition."},
      {
        t: "p",
        node: "The connection to Albers is structural: one fixed format, color as the source of variation, and a complete body of work revealed through repetition.",
      },
      {
        t: "media",
        src: "02_albers_comparison.png",
        alt: "A Josef Albers Homage to the Square beside four Homage works sharing a fixed nested structure with different palettes.",
        caption: "Josef Albers, Homage to the Square from Formulation: Articulation, 1972. Image via Artsy.",
      },
    ],
  },
  {
    h: "From Punk to Homage, completely onchain",
    blocks: [
      {
        t: "p",
        node: (
          <>
            The visual system begins with Josef Albers’s <em>Homage to the Square</em>: nested fields, fixed
            proportions, flat color, and one composition repeated across a larger body of work.
          </>
        ),
      },
      {t: "p", node: "Homage adapts that structure into a system for reading CryptoPunks."},
      {
        t: "p",
        node: (
          <>
            For each Punk, the Homage renderer contract reads its raw pixel data from the{" "}
            <a href="https://evm.now/address/punksdata.eth" target="_blank" rel="noopener noreferrer" className={PC_LINK}>
              PunksData.sol contract
            </a>
            , a public good deployed by{" "}
            <a href="https://x.com/jalilwahdat" target="_blank" rel="noopener noreferrer" className={PC_LINK}>
              @jalilwahdat
            </a>
            , measures how much of each color appears, and arranges the resulting palette into nested
            fields, one ring for every distinct color.
          </>
        ),
      },
      {
        t: "p",
        node: "The geometry and placement remain consistent across the collection. The number of fields, their colors, and the relationships between them come from the individual Punk.",
      },
      {
        t: "p",
        node: "Everything is onchain: the code, the metadata, the source pixel data, and the rendered image. No hosted image server, external metadata service, IPFS asset, or offchain renderer is involved.",
      },
      {
        t: "media",
        src: "03_punk_palette_homage.png",
        alt: "A CryptoPunk, its extracted color palette, and the nested Homage composition generated from it.",
      },
      {
        t: "p",
        node: "Albers selected the colors for each composition. Here, every Punk supplies its own palette and the contract performs the arrangement.",
      },
      {
        t: "p",
        node: "Homage 0 reads Punk 0. Homage 9999 reads Punk 9999. The same visual system is applied across all 10,000.",
      },
    ],
  },
  {
    h: "Permanent pixels, live status",
    blocks: [
      {
        t: "p",
        node: "The central composition is deterministic but the background color reads the source Punk’s current status in the canonical CryptoPunks market.",
      },
      {t: "list", items: ["Unlisted", "Listed", "Carrying a bid", "Wrapped"]},
      {t: "p", node: "The permanent image stays fixed. The Punk’s current status changes the ground around it."},
      {
        t: "media",
        src: "04_live_ground_states.png",
        alt: "The same Homage shown four times with different background colors: unlisted, listed, bid, and wrapped.",
      },
    ],
  },
  {
    h: "Mint, redeem, remint",
    blocks: [
      {
        t: "p",
        node: (
          <>
            Each mint market buys a fixed amount of{" "}
            <a href="https://permanentcollection.art/trade" target="_blank" rel="noopener noreferrer" className={PC_LINK}>
              $111
            </a>{" "}
            at its current price and holds it against the Homage.
          </>
        ),
      },
      {t: "p", node: "Because the amount of $111 is fixed, the ETH required to mint changes with the market."},
      {t: "p", node: "Mint price is determined by"},
      {t: "list", items: ["base mint fee of 0.0042 ETH", "market price of $111 at mint time"]},
      {
        t: "p",
        node: "Each Homage mint market-buys and holds a fixed amount of $111, and the value of those tokens determines the final mint price.",
      },
      {
        t: "p",
        node: "When minting multiples, each additional mint costs 1.1x more as a soft throttle on overminting.",
      },
      {
        t: "media",
        src: "06_mint_redeem_loop.png",
        alt: "A loop: a fixed amount of $111 mints an Homage; burning it returns the $111 and frees the ID to mint again.",
      },
      {t: "sub", text: "Redeeming $111"},
      {
        t: "p",
        node: "The holder can burn the Homage and redeem the fixed amount of $111 in full. A separate redemption fee of 0.001 ETH applies.",
      },
      {
        t: "p",
        node: "Burning removes the active token and returns its ID to the available set. The central composition is tied to the Punk, so it returns when the ID is minted again.",
      },
      {
        t: "p",
        node: "There are 10,000 possible Homage IDs, one for every Punk. Only one active Homage can exist for an ID at a time.",
      },
    ],
  },
  {
    h: "Permanent Collection",
    blocks: [
      {
        t: "p",
        node: (
          <>
            $111 connects Homage to{" "}
            <a href="https://permanentcollection.art" target="_blank" rel="noopener noreferrer" className={PC_LINK}>
              Permanent Collection
            </a>
            , a protocol designed to acquire, permanently hold, and publicly display one CryptoPunk for every
            trait.
          </>
        ),
      },
      {
        t: "p",
        node: "Each Homage mint buys $111 through its official market. Trading fees from that market feed the Permanent Collection live bid. At launch, a portion of each Homage mint and redemption fee will also contribute to the bid.",
      },
      {t: "p", node: "Homage maps all 10,000 Punk IDs."},
      {t: "p", node: "Permanent Collection builds toward one Punk for each of the 111 traits."},
      {t: "p", node: "Holding an Homage or $111 does not provide ownership of the vault or any Punk it holds."},
    ],
  },
]

// The mint windows, in order. `at` is the absolute instant (ET / EDT −04:00); the
// display converts it to the viewer's local timezone client-side. `etLabel` is the
// SSR/no-JS fallback.
const WINDOWS = [
  {
    name: "Punk owners",
    at: "2026-07-22T16:20:00-04:00",
    etLabel: "Wed, Jul 22 · 4:20 PM ET",
    detail: "claim your punk's id",
  },
  {
    name: "Allowlist",
    at: "2026-07-22T18:00:00-04:00",
    etLabel: "Wed, Jul 22 · 6:00 PM ET",
    detail: "random draw",
  },
  {
    name: "Public",
    at: "2026-07-23T12:00:00-04:00",
    etLabel: "Thu, Jul 23 · 12:00 PM ET",
    detail: "all unclaimed Punk ids release into the draw",
  },
]

// Format an absolute instant in the viewer's local timezone. Renders `fallback` (the ET
// label) on the server and first client paint so hydration matches, then swaps to local
// time after mount.
function LocalTime({at, fallback}: {at: string; fallback: string}) {
  const [text, setText] = useState(fallback)
  useEffect(() => {
    setText(
      new Date(at).toLocaleString(undefined, {
        weekday: "short",
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
        timeZoneName: "short",
      }),
    )
  }, [at])
  return <>{text}</>
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
              by{" "}
              <a href="https://x.com/ripe0x" target="_blank" rel="noopener noreferrer" className={PC_LINK}>
                ripe
              </a>
            </p>
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
        <div className="grid w-full grid-cols-1 lg:grid-cols-[2fr_1fr] lg:divide-x lg:divide-gray-200">
          <div className="order-2 mx-auto w-full max-w-[820px] space-y-8 px-6 py-10 lg:order-none lg:px-12 lg:py-12">
            <h2 className={META}>About this work</h2>
            {ABOUT.map((s, i) => (
              <section key={i} className="space-y-4">
                {s.h && <h3 className="text-sm font-medium tracking-tight text-fg">{s.h}</h3>}
                {s.blocks.map((b, j) => {
                  switch (b.t) {
                    case "lead":
                      return (
                        <p key={j} className="text-lg leading-relaxed text-fg sm:text-xl">
                          {b.node}
                        </p>
                      )
                    case "p":
                      return (
                        <p key={j} className="text-sm leading-relaxed text-fg-muted">
                          {b.node}
                        </p>
                      )
                    case "sub":
                      return (
                        <p key={j} className="pt-2 text-sm font-medium tracking-tight text-fg">
                          {b.text}
                        </p>
                      )
                    case "list":
                      return (
                        <ul key={j} className="list-disc space-y-1 pl-5 text-sm leading-relaxed text-fg-muted">
                          {b.items.map((it, k) => (
                            <li key={k}>{it}</li>
                          ))}
                        </ul>
                      )
                    case "media":
                      return (
                        <figure key={j} className="pt-2">
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img
                            src={`${ART}/${b.src}`}
                            alt={b.alt}
                            className="w-full rounded-lg border border-gray-200"
                            loading="lazy"
                          />
                          {b.caption && (
                            <figcaption className="mt-2 text-[10px] font-mono uppercase tracking-wider text-gray-400">
                              {b.caption}
                            </figcaption>
                          )}
                        </figure>
                      )
                  }
                })}
              </section>
            ))}
          </div>

          <div className="order-1 w-full px-6 py-10 lg:order-none lg:px-10 lg:py-12">
            <div className="mx-auto w-full max-w-[440px] space-y-6">
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
                      <div className="flex items-center gap-2 text-[11px] font-mono">
                        <span className="inline-block h-1.5 w-1.5 rounded-full bg-status-upcoming" />
                        <span className="text-fg">{w.name}</span>
                      </div>
                      <p className="pl-3.5 text-[11px] font-mono tabular-nums text-fg-muted">
                        <LocalTime at={w.at} fallback={w.etLabel} />
                      </p>
                      <p className="pl-3.5 text-[10px] font-mono text-gray-500">{w.detail}</p>
                    </li>
                  ))}
                </ul>
              </div>

              {/* Allowlist checker: anyone can confirm eligibility before the window opens.
                  Membership only (the ~1MB companion), so no heavy fetch and zero RPC. */}
              <div className="space-y-3 rounded-lg border border-gray-200 bg-surface p-5">
                <HomageAllowlistLookup />
                <p className="text-[10px] font-mono leading-relaxed text-gray-500">
                  Eligibility is a fixed snapshot (July 21, 2026). Assets acquired after aren&rsquo;t reflected.
                </p>
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
// Regenerate re-deals fresh seeds. Every render is local — zero RPC. Exported for
// reuse on the live collection page's pre-open state (HomageField), where the
// onchain renderer can't yet produce varied output (e.g. a sepolia mock punk data
// source returning one fixture for every id).
export function SampleWall() {
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
