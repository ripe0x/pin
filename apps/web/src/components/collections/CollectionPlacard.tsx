"use client"

/**
 * The placard's live status line and the sticky mint bar: the two pieces of
 * the redesigned collection page that need chain-time.
 *
 * PlacardStatus — one mono line under the exhibition placard: status dot,
 * supply, price, and the countdown that matters for the current state.
 *
 * StickyMintBar — a slim fixed bottom bar shown while a mint is Open or
 * Scheduled AND the mint instrument is off-screen (IntersectionObserver on
 * the instrument's anchor), so the artwork can be full-bleed without ever
 * burying the sale. It renders nothing on closed/sold-out/pooled pages —
 * those pages are a record, not a store.
 */

import { useEffect, useState } from "react"
import { Countdown, useChainNowSec } from "@/components/tx/tx-ui"
import {
  COLLECTION_STATUS_LABEL,
  CollectionStatus,
  formatPriceLabel,
  lifecycleStatus,
} from "@/lib/collection"

export type PlacardSnapshot = {
  price: string
  supplyCap: string
  mintStart: string
  mintEnd: string
  minted: string
  hasStrategy: boolean
  pooled: boolean
}

function useDerived(s: PlacardSnapshot) {
  const nowSec = useChainNowSec()
  const cfg = {
    mintStart: BigInt(s.mintStart),
    mintEnd: BigInt(s.mintEnd),
    supplyCap: BigInt(s.supplyCap),
  }
  const minted = BigInt(s.minted)
  const status = lifecycleStatus(cfg, minted, nowSec)
  const capReached = cfg.supplyCap > 0n && minted >= cfg.supplyCap
  const soldOut = status === CollectionStatus.Closed && capReached
  return { nowSec, cfg, minted, status, soldOut }
}

function dotClass(status: number, soldOut: boolean): string {
  if (status === CollectionStatus.Open) return "bg-status-available animate-pulse"
  if (status === CollectionStatus.Scheduled) return "bg-status-upcoming"
  return soldOut ? "bg-status-sold" : "bg-gray-400"
}

/**
 * Display-scale masthead stats (the gm.studio move): the numbers ARE the
 * status. Each stat is a big tabular numeral with a micro-label beneath it;
 * the status dot rides the first micro-label. Reads at a glance from
 * across the room, the way a gallery wall label doesn't make you squint.
 */
export function PlacardStats({ snapshot }: { snapshot: PlacardSnapshot }) {
  const { nowSec, cfg, minted, status, soldOut } = useDerived(snapshot)
  const label = soldOut ? "Sold out" : COLLECTION_STATUS_LABEL[status]

  return (
    <div className="flex flex-wrap items-end gap-x-10 gap-y-4">
      <Stat
        value={
          cfg.supplyCap > 0n
            ? `${minted.toString()} / ${cfg.supplyCap.toString()}`
            : minted.toString()
        }
        label={
          <span className="flex items-center gap-2">
            <span
              className={`inline-block h-1.5 w-1.5 rounded-full ${dotClass(status, soldOut)}`}
            />
            {label} · {cfg.supplyCap > 0n ? "minted / total" : "minted · open edition"}
          </span>
        }
      />
      {!snapshot.pooled && (
        <Stat
          value={snapshot.hasStrategy ? "Live" : formatPriceLabel(BigInt(snapshot.price))}
          label={snapshot.hasStrategy ? "price · updates onchain" : "price"}
        />
      )}
      {status === CollectionStatus.Scheduled && cfg.mintStart > 0n && (
        <Stat value={<Countdown endTime={cfg.mintStart} nowSec={nowSec} />} label="opens in" />
      )}
      {status === CollectionStatus.Open && cfg.mintEnd > 0n && (
        <Stat value={<Countdown endTime={cfg.mintEnd} nowSec={nowSec} />} label="closes in" />
      )}
    </div>
  )
}

function Stat({ value, label }: { value: React.ReactNode; label: React.ReactNode }) {
  return (
    <div>
      <p className="text-3xl font-medium tracking-tight tabular-nums leading-none sm:text-4xl">
        {value}
      </p>
      <p className="mt-2 text-[10px] font-mono uppercase tracking-wider text-gray-400">{label}</p>
    </div>
  )
}

export function StickyMintBar({
  snapshot,
  anchorId,
}: {
  snapshot: PlacardSnapshot
  /** DOM id of the mint instrument; the bar hides while it's on screen. */
  anchorId: string
}) {
  const { nowSec, cfg, minted, status } = useDerived(snapshot)
  const [instrumentVisible, setInstrumentVisible] = useState(true)

  useEffect(() => {
    const el = document.getElementById(anchorId)
    if (!el) return
    const obs = new IntersectionObserver(
      ([entry]) => setInstrumentVisible(entry.isIntersecting),
      { rootMargin: "0px 0px -10% 0px" },
    )
    obs.observe(el)
    return () => obs.disconnect()
  }, [anchorId])

  const live = status === CollectionStatus.Open || status === CollectionStatus.Scheduled
  if (!live || snapshot.pooled || instrumentVisible) return null

  return (
    <div className="fixed inset-x-0 bottom-0 z-40 border-t border-gray-200 bg-bg/95 backdrop-blur-sm">
      <div className="mx-auto flex max-w-[1400px] items-center justify-between gap-4 px-6 py-3 lg:px-12">
        <p className="flex items-center gap-3 text-[11px] font-mono uppercase tracking-wider text-gray-500 tabular-nums">
          <span
            className={`inline-block h-1.5 w-1.5 rounded-full ${dotClass(status, false)}`}
          />
          <span className="hidden sm:inline">
            {cfg.supplyCap > 0n
              ? `${minted.toString()} / ${cfg.supplyCap.toString()}`
              : `${minted.toString()} minted`}
          </span>
          <span>
            {snapshot.hasStrategy ? "Live price" : formatPriceLabel(BigInt(snapshot.price))}
          </span>
        </p>
        {status === CollectionStatus.Open ? (
          <a
            href={`#${anchorId}`}
            className="px-6 py-2 text-[11px] font-mono font-medium uppercase tracking-wider bg-fg text-bg hover:opacity-80 transition-opacity"
          >
            Mint
          </a>
        ) : (
          <p className="text-[11px] font-mono uppercase tracking-wider text-gray-500 tabular-nums">
            Opens in <Countdown endTime={cfg.mintStart} nowSec={nowSec} />
          </p>
        )}
      </div>
    </div>
  )
}
