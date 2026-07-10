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

export function PlacardStatus({ snapshot }: { snapshot: PlacardSnapshot }) {
  const { nowSec, cfg, minted, status, soldOut } = useDerived(snapshot)
  const label = soldOut ? "Sold out" : COLLECTION_STATUS_LABEL[status]

  return (
    <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] font-mono uppercase tracking-wider text-gray-500 tabular-nums">
      <span className="flex items-center gap-2">
        <span className={`inline-block h-1.5 w-1.5 rounded-full ${dotClass(status, soldOut)}`} />
        {label}
      </span>
      <span className="text-gray-300 dark:text-gray-700">·</span>
      <span>
        {cfg.supplyCap > 0n
          ? `${minted.toString()} / ${cfg.supplyCap.toString()} minted`
          : `${minted.toString()} minted · open edition`}
      </span>
      {!snapshot.pooled && (
        <>
          <span className="text-gray-300 dark:text-gray-700">·</span>
          <span>
            {snapshot.hasStrategy ? "Live price" : formatPriceLabel(BigInt(snapshot.price))}
          </span>
        </>
      )}
      {status === CollectionStatus.Scheduled && cfg.mintStart > 0n && (
        <>
          <span className="text-gray-300 dark:text-gray-700">·</span>
          <span>
            Opens in <Countdown endTime={cfg.mintStart} nowSec={nowSec} />
          </span>
        </>
      )}
      {status === CollectionStatus.Open && cfg.mintEnd > 0n && (
        <>
          <span className="text-gray-300 dark:text-gray-700">·</span>
          <span>
            Closes in <Countdown endTime={cfg.mintEnd} nowSec={nowSec} />
          </span>
        </>
      )}
    </p>
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
