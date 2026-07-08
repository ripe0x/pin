"use client"

// /mint/homage — the anonymized wall, ported from the Homage site's /gallery
// (permanence origin/master:web/app/gallery/page.tsx) and driven by PND's
// generic mint engine (use-mint-engine.ts) instead of the Homage repo's own
// controller. Real works dealt from the whole 10k collection, shuffled, at
// mixed scales, with every punk id withheld. The wall breathes (one tile at a
// time crossfades to a fresh, never-yet-shown work), a click opens any piece
// large and still unnumbered, and the deck deals more as you scroll. Renders
// are fully local via the parity-proven SDK port — zero RPC for the wall.
//
// The wall is the base layout for EVERY phase — only the lockup above it
// changes:
//   pre-mint   "minting soon" chip, coming-soon line — the wall teases the system
//   open       the HomageTermMint block joins the lockup; ids stay withheld
//              because WHICH one you get is the draw — the wall is the deck
//   pending    the whole wall becomes the slot machine (rapid batch crossfades)
//   minted     the reveal: your drawn piece takes over full-screen, numbered
//
// Site chrome: PND's navbar renders transparent above this page and the site
// footer is dropped (lib/curated-chrome.ts) — the root's pt-16 tucks the
// lockup below the overlaid 64px bar. `dark` on the root re-tunes PND tokens
// for any embedded PND components; `homage-terminal` is the fixed look
// (homage-gallery.css) with no light/dark participation.

import { useCallback, useEffect, useRef, useState } from "react"
import { useRouter } from "next/navigation"
import { evmNowTxUrl, PREFERRED_CHAIN } from "@/components/tx/tx-ui"
import type { CuratedLayoutProps } from "../curated-layouts"
import { useMintEngine, type MintEngine } from "../use-mint-engine"
import { CrossfadeArt } from "./CrossfadeArt"
import { makeDealer, randomSpan, type Piece } from "./gallery-deck"
import { HomageTermMint } from "./HomageTermMint"
import { useLocalArt, useLocalSample } from "./local"
import { groundFromSrc, inkVarsFor } from "./reveal-ink"
import { statusByCode, STATUSES } from "./status"
import { accessories, trait } from "./svg"
import "./homage-gallery.css"

type Tile = Piece & { span: number; key: number }

const INITIAL = 72 // first deal — roughly two viewports of quilt
const APPEND = 48 // per scroll-sentinel hit
const GAP = 8 // dark wall showing between works
const TARGET_CELL = 176 // desired 1×1 cell size; columns derive from width
const BREATH_MS = 2400 // ambient swap cadence
const SPIN_MS = 120 // slot-machine cadence while a mint tx is mining
const SPIN_BATCH = 6 // tiles swapped per spin tick — the whole wall shimmers

export default function HomageGalleryLayout({ collectionId, snapshot, selectorData }: CuratedLayoutProps) {
  const dealer = useRef<() => Piece>(undefined)
  const nextKey = useRef(0)
  const [tiles, setTiles] = useState<Tile[]>([])
  const [focus, setFocus] = useState<Piece | null>(null)
  const reduced = useReducedMotion()
  const router = useRouter()

  // ── mint state: PND's generic engine, quote gated like the Homage site
  // (polls only while a window is open AND no reveal is on screen) ──────────
  const [quoteEnabled, setQuoteEnabled] = useState(true)
  const m = useMintEngine(collectionId, snapshot, { quoteEnabled })

  const preMint = !m.activePhase
  const busy = m.busy
  const revealedId = m.revealedTokenId !== null ? Number(m.revealedTokenId) : null
  const revealed = revealedId !== null
  const spinning = busy === "pending" && !reduced

  useEffect(() => {
    setQuoteEnabled(!preMint && !revealed)
  }, [preMint, revealed])

  // "mint another" clears the write state and returns to the wall; the
  // refresh re-fetches the server snapshot so the outstanding count moves.
  const reset = m.reset
  const onAnother = useCallback(() => {
    reset()
    router.refresh()
  }, [reset, router])

  const draw = useCallback((): Piece => {
    if (!dealer.current) dealer.current = makeDealer()
    return dealer.current()
  }, [])

  const deal = useCallback(
    (n: number) =>
      Array.from({ length: n }, (): Tile => ({ ...draw(), span: randomSpan(), key: nextKey.current++ })),
    [draw],
  )

  // first deal happens client-side only (Math.random), never during SSR render
  useEffect(() => {
    setTiles(deal(INITIAL))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // The wall breathes: every BREATH_MS one tile crossfades to a fresh, unseen
  // work. While a mint tx is mining it becomes the slot machine — a batch of
  // tiles swaps every SPIN_MS, the whole wall shimmering while the draw
  // decides. Spans and keys stay put so the layout never shifts, only the art
  // inside the frames changes. Reduced-motion users keep the calm breath.
  useEffect(() => {
    if (reduced || !tiles.length || revealed) return
    const t = setInterval(
      () => {
        if (document.hidden) return
        setTiles((cur) => {
          if (!cur.length) return cur
          const next = [...cur]
          const swaps = spinning ? SPIN_BATCH : 1
          for (let k = 0; k < swaps; k++) {
            const i = Math.floor(Math.random() * next.length)
            next[i] = { ...next[i], ...draw() }
          }
          return next
        })
      },
      spinning ? SPIN_MS : BREATH_MS,
    )
    return () => clearInterval(t)
  }, [reduced, tiles.length > 0, draw, spinning, revealed]) // eslint-disable-line react-hooks/exhaustive-deps

  const append = useCallback(() => setTiles((cur) => [...cur, ...deal(APPEND)]), [deal])

  // mono status line while a window is open: the live phase, and what's next
  const phaseLine = m.activePhase
    ? (() => {
        const label = m.activePhase.label.toLowerCase()
        const next =
          m.phaseState && m.phaseState.nextIndex >= 0 && m.phaseWindows
            ? m.phaseWindows[m.phaseState.nextIndex]
            : null
        const secs = next ? Math.max(Number(BigInt(next.start) - BigInt(m.nowSec)), 0) : null
        return next && secs !== null
          ? `${label} · ${next.label.toLowerCase()} in ${fmtCountdown(secs)}`
          : `${label} · open`
      })()
    : null

  return (
    <div className="homage-terminal dark min-h-screen overflow-x-clip pt-16">
      {/* lockup */}
      <section className="mx-auto max-w-[880px] px-6 sm:px-8 pt-14 sm:pt-20 pb-10">
        <div className="flex items-center justify-between gap-4">
          <div className="eyebrow-a">onchain · generative</div>
          <div className="flex items-center gap-4 font-mono text-[11px] text-(--dim)">
            {preMint ? (
              <span className="chip">minting soon</span>
            ) : (
              <>
                <span className="chip">{m.activePhase!.label.toLowerCase()}</span>
                <span className="hidden sm:inline tracking-[0.1em] tabular">{m.supplyText}</span>
              </>
            )}
          </div>
        </div>
        <h1 className="display mt-5 max-w-[16ch]">A homage for every punk</h1>
        <p className="text-[14px] leading-[1.75] text-(--dim) mt-7 max-w-[54ch]">
          Ten thousand generative artworks. One for each cryptopunk. Each composed from the
          punk&rsquo;s onchain data and its live market state.
        </p>
        <p className="text-[14px] leading-[1.75] text-(--dim) mt-5 max-w-[54ch]">
          Every piece is backed by 50,000&nbsp;<span className="text-(--accent)">$111</span> sealed
          inside, redeemable in full at any time. Half of every fee feeds the Permanent Collection,
          a pool that buys real punks and holds them for good.
        </p>

        {preMint ? (
          <p className="mt-6 font-mono text-[11px] tracking-[0.12em] uppercase text-(--faint)">
            Minting isn&rsquo;t live yet. Coming soon.
          </p>
        ) : (
          <>
            <p className="mt-6 font-mono text-[11px] tracking-[0.12em] uppercase text-(--faint)">
              {phaseLine}
            </p>
            {/* the mint block — the wall below is the deck the draw pulls from */}
            <div className="mt-6">
              <HomageTermMint m={m} selectorData={selectorData} />
            </div>
          </>
        )}

        {/* ground legend — the one system fact worth teaching before the wall (desktop only) */}
        <div className="mt-8 hidden sm:flex flex-wrap gap-x-6 gap-y-2 font-mono text-[10px] tracking-[0.12em] uppercase text-(--faint)">
          <span className="text-(--dim) normal-case tracking-normal">
            the ground is the punk&rsquo;s live market state
          </span>
          {STATUSES.map((s) => (
            <span key={s.key} className="flex items-center gap-2">
              <span className="inline-block w-[10px] h-[10px]" style={{ background: s.color }} />
              {s.label}
            </span>
          ))}
        </div>
      </section>

      {/* the wall */}
      <Quilt tiles={tiles} onFocus={setFocus} />
      <Sentinel onHit={append} enabled={tiles.length > 0} />

      <footer className="mx-auto max-w-[880px] px-6 sm:px-8 py-12">
        <span className="font-mono text-[10px] text-(--faint)">
          every work above is one of the ten thousand
        </span>
      </footer>

      {focus && !revealed && <FocusOverlay first={focus} draw={draw} onClose={() => setFocus(null)} />}
      {revealed && <RevealOverlay id={revealedId!} m={m} onAnother={onAnother} />}
    </div>
  )
}

/* ── the quilt: full-bleed CSS grid, square base cells, dense-packed 1×/2×/3× spans ── */

const PAD = GAP // edge inset, matched to the gap so the wall's border reads as one more seam

function Quilt({ tiles, onFocus }: { tiles: Tile[]; onFocus: (p: Piece) => void }) {
  const ref = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(0)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    setWidth(el.clientWidth)
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(() => setWidth(el.clientWidth)) : null
    ro?.observe(el)
    return () => ro?.disconnect()
  }, [])

  // Explicit, identical px tracks for BOTH axes. Deriving rows from the padded container
  // width (while columns were 1fr of the content box) left every row a few px taller than
  // its column, so each SVG letterboxed vertically and the seams read as uneven bands.
  const cw = Math.max(0, width - PAD * 2)
  const cols = Math.max(3, Math.floor((cw + GAP) / (TARGET_CELL + GAP)))
  const track = cw ? (cw - GAP * (cols - 1)) / cols : TARGET_CELL

  return (
    <div
      ref={ref}
      style={{ width: "100vw", marginLeft: "calc(50% - 50vw)", paddingLeft: PAD, paddingRight: PAD }}
    >
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
        {tiles.map((t) => (
          <WallTile key={t.key} tile={t} maxSpan={cols} onFocus={() => onFocus({ id: t.id, status: t.status })} />
        ))}
      </div>
    </div>
  )
}

function WallTile({ tile, maxSpan, onFocus }: { tile: Tile; maxSpan: number; onFocus: () => void }) {
  const { src } = useLocalArt(tile.id, tile.status)
  const span = Math.min(tile.span, maxSpan)
  return (
    <button
      onClick={onFocus}
      aria-label="view this homage larger"
      className="relative block overflow-hidden cursor-pointer focus:outline-none focus-visible:ring-1 focus-visible:ring-white/50"
      style={{ gridColumn: `span ${span}`, gridRow: `span ${span}` }}
    >
      <CrossfadeArt src={src} alt="a homage from the collection" />
    </button>
  )
}

/* ── focus: the work large on its own ground, with its traits but never its number. A dealt
      history: → / click the work advances (drawing a fresh work at the end), ← steps back,
      Esc or a click on the ground closes. ── */

function FocusOverlay({ first, draw, onClose }: { first: Piece; draw: () => Piece; onClose: () => void }) {
  // one dealt sequence the arrows walk; the end draws a new, never-yet-shown work
  const [nav, setNav] = useState<{ hist: Piece[]; idx: number }>({ hist: [first], idx: 0 })
  const piece = nav.hist[nav.idx]

  const next = useCallback(
    () =>
      setNav((n) =>
        n.idx < n.hist.length - 1
          ? { ...n, idx: n.idx + 1 }
          : { hist: [...n.hist, draw()], idx: n.idx + 1 },
      ),
    [draw],
  )
  const prev = useCallback(() => setNav((n) => ({ ...n, idx: Math.max(0, n.idx - 1) })), [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose()
      else if (e.key === "ArrowRight") next()
      else if (e.key === "ArrowLeft") prev()
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [onClose, next, prev])

  const { src, meta } = useLocalSample(piece.id, piece.status)
  const ground = statusByCode(piece.status).color

  // every trait the token would carry, minus the one thing withheld pre-mint: which punk it is
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
      className="fixed inset-0 z-[60] flex flex-col items-center justify-center cursor-pointer"
      style={{ background: ground, transition: "background-color 800ms ease" }}
    >
      <div
        onClick={(e) => {
          e.stopPropagation()
          next()
        }}
        className="relative"
        style={{ width: "min(72vmin, 720px)", aspectRatio: "1 / 1" }}
        title="another"
      >
        <CrossfadeArt src={src} alt="a homage from the collection" fadeMs={700} />
      </div>
      <div className="absolute bottom-0 inset-x-0 pb-7 px-6 flex flex-col items-center gap-2 pointer-events-none text-center">
        <span
          className="font-mono text-[11px] tracking-[0.22em] uppercase"
          style={{ color: "rgba(255,255,255,0.9)" }}
        >
          one of ten thousand
        </span>
        {traits.length > 0 && (
          <span
            className="font-mono text-[11px] tracking-[0.06em] max-w-[64ch] leading-relaxed"
            style={{ color: "rgba(255,255,255,0.72)" }}
          >
            {traits.join(" · ")}
          </span>
        )}
      </div>
    </div>
  )
}

/* ── the reveal: the wall's payoff. The id-withheld tension resolves — YOUR drawn piece takes
      over the screen on its own ground, numbered at last, with its full traits, the tx, and a
      way back to the wall. Esc or the ground also return (the piece is safely yours either
      way; this is a view, not a decision). ── */

function RevealOverlay({ id, m, onAnother }: { id: number; m: MintEngine; onAnother: () => void }) {
  const { src, meta } = useLocalSample(id, 0)
  const ground = (src ? groundFromSrc(src) : null) ?? "#0a0a0c"
  const ink = inkVarsFor(ground)

  // Routed claims (claimFor/claimTo) mint to the vault / punk holder, not the
  // payer — the payoff copy says so instead of claiming "yours".
  const route =
    m.selection && typeof m.selection === "object" && "route" in m.selection
      ? (m.selection as { route: { via: string } }).route.via
      : "self"
  const eyebrow =
    route === "delegated"
      ? "minted · to your vault"
      : route === "anyone"
        ? "minted · to the punk's holder"
        : "minted · yours"

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onAnother()
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [onAnother])

  const traits = meta
    ? [trait(meta, "Punk Type"), ...accessories(meta), `${trait(meta, "Color Count")} colors`].filter(Boolean)
    : []

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`your minted homage to punk ${id}`}
      onClick={onAnother}
      className="fixed inset-0 z-[60] flex flex-col items-center justify-center"
      style={{ background: ground, transition: "background-color 800ms ease", ...ink }}
    >
      <div
        className="relative"
        onClick={(e) => e.stopPropagation()}
        style={{ width: "min(62vmin, 640px)", aspectRatio: "1 / 1" }}
      >
        <CrossfadeArt src={src} alt={`homage to punk ${id}`} fadeMs={700} />
      </div>
      <div
        onClick={(e) => e.stopPropagation()}
        className="mt-7 px-6 flex flex-col items-center gap-2 text-center cursor-default"
      >
        <span className="eyebrow-a">{eyebrow}</span>
        <span className="display-lockup">Homage to punk {id}</span>
        {traits.length > 0 && (
          <span className="font-mono text-[11px] tracking-[0.06em] text-(--dim) max-w-[64ch] leading-relaxed">
            {traits.join(" · ")}
          </span>
        )}
        <div className="mt-4 flex flex-col items-center gap-3">
          <button onClick={onAnother} className="btn-primary !w-auto px-10">
            Mint another
          </button>
          {m.txHash && (
            <a
              href={evmNowTxUrl(m.txHash, PREFERRED_CHAIN.id)}
              target="_blank"
              rel="noreferrer"
              className="font-mono text-[11px] text-(--dim) underline underline-offset-4 decoration-(--line) hover:decoration-(--ink)"
            >
              view transaction ↗
            </a>
          )}
        </div>
      </div>
    </div>
  )
}

/* ── infra ── */

/** IntersectionObserver sentinel: deals more works as the viewport nears the wall's end. */
function Sentinel({ onHit, enabled }: { onHit: () => void; enabled: boolean }) {
  const ref = useRef<HTMLDivElement>(null)
  const cb = useRef(onHit)
  cb.current = onHit
  useEffect(() => {
    if (!enabled || !ref.current) return
    const io = new IntersectionObserver((es) => es.some((e) => e.isIntersecting) && cb.current(), {
      rootMargin: "1400px",
    })
    io.observe(ref.current)
    return () => io.disconnect()
  }, [enabled])
  return <div ref={ref} className="h-px" />
}

function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false)
  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)")
    setReduced(mq.matches)
    const on = (e: MediaQueryListEvent) => setReduced(e.matches)
    mq.addEventListener("change", on)
    return () => mq.removeEventListener("change", on)
  }, [])
  return reduced
}

/** Format a positive second-delta as a compact countdown, e.g. "2d 4h", "3h 12m", "45s". */
function fmtCountdown(secs: number): string {
  if (secs <= 0) return "0s"
  const d = Math.floor(secs / 86400)
  const h = Math.floor((secs % 86400) / 3600)
  const mn = Math.floor((secs % 3600) / 60)
  const s = secs % 60
  if (d > 0) return `${d}d ${h}h`
  if (h > 0) return `${h}h ${mn}m`
  if (mn > 0) return `${mn}m ${s}s`
  return `${s}s`
}
