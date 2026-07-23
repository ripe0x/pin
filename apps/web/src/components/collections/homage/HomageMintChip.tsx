"use client"

// A minimized homage mint affordance so the sale is findable without scrolling: live
// status dot + phase label + an indicative live price + a "Mint" jump to the full
// instrument. Two variants off one data path:
//   masthead — inline in the page masthead, above the fold
//   sticky   — fixed bottom bar, shown only while the instrument is off-screen
//              (the generic StickyMintBar pattern; that one bails on pooled
//              collections and reads the Surface direct-sale price, so homage
//              needs this quote-aware variant).
// The chip never writes — it routes to the instrument, which owns quoting-at-sign,
// batch, reveal, and errors. Price here is indicative (swap + flat baseFee) on a
// slow poll; the instrument shows the caller's exact fee.

import {useCallback, useEffect, useState} from "react"
import {formatEther, type Address} from "viem"
import {usePublicClient} from "wagmi"
import {useReadContracts} from "wagmi"
import {Countdown, PREFERRED_CHAIN, useChainNowSec} from "@/components/tx/tx-ui"
import {BASE_FEE, homageMinterAbi, quoteMint} from "@/lib/homage/contracts"
import {WINDOW_LABEL, type Phase, type Schedule, currentPhase, nextTransition, reservationOpenAt} from "@/lib/homage/phase"

const QUOTE_POLL_MS = 60_000 // indicative price only — keep this cold (paid RPC in prod)

const PHASE_CHIP_LABEL: Record<Phase, string> = {
  closed: "Mint not open",
  claim: "Punk mint claim open",
  allowlist: "Allowlist open",
  public: "Mint open",
}

// How a window is NAMED in the masthead countdown label ("punk mint claim closes in …").
const WINDOW_NAME = WINDOW_LABEL

function fmtEth(wei: bigint): string {
  const [int, frac = ""] = formatEther(wei).split(".")
  const trimmed = frac.slice(0, 4).replace(/0+$/, "")
  return trimmed ? `${int}.${trimmed}` : int
}

function useChipState(minter: Address) {
  const publicClient = usePublicClient({chainId: PREFERRED_CHAIN.id})
  const nowSec = useChainNowSec()
  const reads = useReadContracts({
    contracts: [
      {address: minter, abi: homageMinterAbi, functionName: "claimStart", chainId: PREFERRED_CHAIN.id},
      {address: minter, abi: homageMinterAbi, functionName: "allowlistStart", chainId: PREFERRED_CHAIN.id},
      {address: minter, abi: homageMinterAbi, functionName: "publicStart", chainId: PREFERRED_CHAIN.id},
      {address: minter, abi: homageMinterAbi, functionName: "remaining", chainId: PREFERRED_CHAIN.id},
    ],
  })
  const schedule: Schedule | null =
    reads.data && reads.data[0]?.status === "success"
      ? {
          claimStart: Number(reads.data[0].result as bigint),
          allowlistStart: Number(reads.data[1].result as bigint),
          publicStart: Number(reads.data[2].result as bigint),
        }
      : null
  const soldOut = reads.data?.[3]?.status === "success" && (reads.data[3].result as bigint) === 0n
  const phase: Phase = schedule ? currentPhase(schedule, nowSec) : "closed"
  const reservationIsOpen = schedule ? reservationOpenAt(schedule, nowSec) : false

  const [price, setPrice] = useState<bigint | null>(null)
  const refresh = useCallback(async () => {
    if (!publicClient) return
    try {
      const q = await quoteMint(publicClient, minter, BASE_FEE)
      setPrice(q.totalValue)
    } catch {
      /* keep last */
    }
  }, [publicClient, minter])
  useEffect(() => {
    if (phase === "closed" || soldOut) return
    void refresh()
    const t = setInterval(() => {
      if (typeof document !== "undefined" && document.visibilityState !== "visible") return
      void refresh()
    }, QUOTE_POLL_MS)
    return () => clearInterval(t)
  }, [phase, soldOut, refresh])

  // The next window boundary: what the countdown ticks toward. During claim/allowlist
  // it's when the CURRENT window closes; while closed it's when minting opens.
  const next = schedule ? nextTransition(schedule, nowSec) : null

  return {phase, soldOut, price, next, nowSec, reservationIsOpen}
}

/** The chip's countdown fragment: "closes in X" inside a timed window, "opens in X"
 *  before one. Null when there's no boundary ahead (public / unscheduled). */
function ChipCountdown({
  phase,
  next,
  nowSec,
  reservationIsOpen,
}: {
  phase: Phase
  next: {at: number} | null
  nowSec: number
  reservationIsOpen?: boolean
}) {
  if (!next || phase === "public") return null
  return (
    <span className="font-mono text-[10px] uppercase tracking-wider text-gray-400 tabular-nums">
      {phase === "closed" ? (reservationIsOpen ? "mint opens in " : "opens in ") : "closes in "}
      <span className="text-fg">
        <Countdown endTime={BigInt(next.at)} nowSec={nowSec} />
      </span>
    </span>
  )
}

function Dot({phase, soldOut}: {phase: Phase; soldOut: boolean}) {
  const cls = soldOut ? "bg-status-sold" : phase !== "closed" ? "bg-status-available animate-pulse" : "bg-status-upcoming"
  return <span className={`inline-block h-1.5 w-1.5 rounded-full ${cls}`} />
}

/**
 * The masthead's status cluster: one BIG stat slot + the mint chip, off one shared
 * data path. Hierarchy follows what matters right now: during a timed window the
 * big slot is the ticking countdown (the scarce thing is time) and the minted
 * count folds into the chip, small; in public / sold out there is no boundary
 * ahead, so the count takes the big slot back (the scarce thing is supply).
 */
export function HomageMastheadStat({
  minter,
  minted,
  supplyCap,
  anchorId,
  chipId,
}: {
  minter: Address
  minted: string
  supplyCap: string
  anchorId: string
  /** id for the chip element (the sticky bar watches it to avoid doubling up). */
  chipId?: string
}) {
  const {phase, soldOut, price, next, nowSec, reservationIsOpen} = useChipState(minter)
  const timed = !soldOut && next !== null && phase !== "public"
  const showReservation = !soldOut && phase === "closed" && reservationIsOpen

  return (
    // Stacked on phones: side by side, the countdown and the chip each get too little
    // width and both wrap mid-value.
    <div className="flex flex-col items-start gap-3 sm:flex-row sm:items-center sm:gap-5">
      <p className="font-mono text-xl tabular-nums tracking-tight text-fg sm:text-2xl">
        {timed ? (
          <>
            <span className="mr-3 align-[0.2em] font-mono text-[10px] uppercase tracking-wider text-gray-500">
              {phase === "closed" || phase === "allowlist"
                ? `${WINDOW_NAME[next!.to]} opens in`
                : `${WINDOW_NAME[phase]} closes in`}
            </span>
            <Countdown endTime={BigInt(next!.at)} nowSec={nowSec} />
          </>
        ) : (
          <>
            {minted} <span className="text-gray-500">/ {supplyCap}</span>
          </>
        )}
      </p>
      <div id={chipId} className="flex items-center gap-4 rounded border border-gray-200 bg-surface px-4 py-3">
        <span className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-wider text-gray-500">
          <Dot phase={phase} soldOut={soldOut} />
          {soldOut ? "Sold out" : showReservation ? "Reserve your punk" : PHASE_CHIP_LABEL[phase]}
        </span>
        {showReservation && <ChipCountdown phase={phase} next={next} nowSec={nowSec} reservationIsOpen />}
        {/* the small slot mirrors the big one: count while the countdown is big */}
        {timed && (
          <span className="font-mono text-[10px] uppercase tracking-wider text-gray-400 tabular-nums">
            {minted} / {supplyCap}
          </span>
        )}
        {!soldOut && phase !== "closed" && price !== null && (
          <span className="font-mono text-[11px] tabular-nums text-fg">
            <span className="text-gray-500">from </span>
            {fmtEth(price)} ETH
          </span>
        )}
        {!soldOut && phase !== "closed" && (
          <a
            href={`#${anchorId}`}
            className="px-4 py-1.5 font-mono text-[10px] font-medium uppercase tracking-wider bg-fg text-bg transition-opacity hover:opacity-80"
          >
            Mint
          </a>
        )}
      </div>
    </div>
  )
}

export function HomageStickyMintBar({
  minter,
  anchorId,
  chipId,
}: {
  minter: Address
  anchorId: string
  /** Optional id of the masthead chip — the bar stays hidden while EITHER the
   *  instrument or the chip is on screen, so the two never show together. */
  chipId?: string
}) {
  const {phase, soldOut, price, next, nowSec} = useChipState(minter)
  const [anyVisible, setAnyVisible] = useState(true)

  // Scroll-driven visibility (not IntersectionObserver — IO doesn't fire reliably in
  // embedded/preview renderers, and a missed callback here means a stuck bar). A
  // rAF-throttled scroll/resize listener with getBoundingClientRect is deterministic:
  // the bar shows only while BOTH the instrument and the masthead chip are off-screen.
  useEffect(() => {
    let raf = 0
    const onScreen = (id: string | undefined) => {
      const el = id ? document.getElementById(id) : null
      if (!el) return false
      const r = el.getBoundingClientRect()
      // Degenerate embedded renderers report EVERY viewport-height API as 0 (and fire
      // no scroll events). Fail closed there — claim "visible" so the bar stays hidden
      // rather than pinned open over the page.
      const vh = document.documentElement.clientHeight || window.innerHeight
      if (!vh) return true
      return r.top < vh * 0.9 && r.bottom > 0
    }
    const compute = () => {
      raf = 0
      setAnyVisible(onScreen(anchorId) || onScreen(chipId))
    }
    const schedule = () => {
      if (!raf) raf = requestAnimationFrame(compute)
    }
    compute()
    window.addEventListener("scroll", schedule, {passive: true})
    window.addEventListener("resize", schedule)
    return () => {
      if (raf) cancelAnimationFrame(raf)
      window.removeEventListener("scroll", schedule)
      window.removeEventListener("resize", schedule)
    }
  }, [anchorId, chipId])

  if (soldOut || phase === "closed" || anyVisible) return null

  return (
    <div className="fixed inset-x-0 bottom-0 z-40 border-t border-gray-200 bg-bg/95 backdrop-blur-sm">
      <div className="mx-auto flex max-w-[1400px] items-center justify-between gap-4 px-6 py-3 lg:px-12">
        <p className="flex items-center gap-3 font-mono text-[11px] uppercase tracking-wider text-gray-500 tabular-nums">
          <Dot phase={phase} soldOut={soldOut} />
          <span>{PHASE_CHIP_LABEL[phase]}</span>
          <ChipCountdown phase={phase} next={next} nowSec={nowSec} />
          {price !== null && (
            <span className="text-fg">
              <span className="text-gray-500">from </span>
              {fmtEth(price)} ETH
            </span>
          )}
        </p>
        <a
          href={`#${anchorId}`}
          className="px-6 py-2 font-mono text-[11px] font-medium uppercase tracking-wider bg-fg text-bg transition-opacity hover:opacity-80"
        >
          Mint
        </a>
      </div>
    </div>
  )
}
