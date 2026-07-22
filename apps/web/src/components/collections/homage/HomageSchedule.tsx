"use client"

// The mint schedule — every window, its local time, and its live state. Shown in ALL
// phases (the pre-mint page especially needs it: what's coming, and when), as a quiet
// sub-section of the About area. Reads the same three schedule slots the instrument
// and chip use (wagmi dedupes the calls), and renders states off chain time:
//   upcoming  → "opens <local time>"
//   live      → pulsing dot + "closes <local time>" (public is open-ended)
//   ended     → struck name
// Collapsed windows (equal bounds — the owner skipping a phase) are omitted, matching
// the contract's gating. An all-zero schedule shows "not yet scheduled".

import {type Address} from "viem"
import {useReadContracts} from "wagmi"
import {PREFERRED_CHAIN, useChainNowSec} from "@/components/tx/tx-ui"
import {homageMinterAbi} from "@/lib/homage/contracts"
import {HomageScheduleCard, type ScheduleRow} from "./HomageScheduleCard"

function fmtTime(ts: number): string {
  return new Date(ts * 1000).toLocaleString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  })
}

type Row = {name: string; detail: string; start: number; end: number | null}

export function HomageSchedule({minter}: {minter: Address}) {
  const nowSec = useChainNowSec()
  const reads = useReadContracts({
    contracts: [
      {address: minter, abi: homageMinterAbi, functionName: "claimStart", chainId: PREFERRED_CHAIN.id},
      {address: minter, abi: homageMinterAbi, functionName: "allowlistStart", chainId: PREFERRED_CHAIN.id},
      {address: minter, abi: homageMinterAbi, functionName: "publicStart", chainId: PREFERRED_CHAIN.id},
    ],
  })
  if (!reads.data || reads.data[0]?.status !== "success") return null
  const claimStart = Number(reads.data[0].result as bigint)
  const allowlistStart = Number(reads.data[1].result as bigint)
  const publicStart = Number(reads.data[2].result as bigint)

  const rows: Row[] = []
  if (claimStart !== 0 && claimStart < allowlistStart)
    rows.push({name: "Punk owner claim", detail: "punk holders mint their own id", start: claimStart, end: allowlistStart})
  if (allowlistStart !== 0 && allowlistStart < publicStart)
    rows.push({name: "Allowlist", detail: "random draw, flat fee", start: allowlistStart, end: publicStart})
  if (publicStart !== 0)
    rows.push({name: "Public", detail: "anyone, random draw", start: publicStart, end: null})

  const cardRows: ScheduleRow[] = rows.map((r) => {
    const live = nowSec >= r.start && (r.end === null || nowSec < r.end)
    const ended = r.end !== null && nowSec >= r.end
    return {
      name: r.name,
      detail: r.detail,
      state: live ? "live" : ended ? "ended" : "upcoming",
      time: ended
        ? "Ended"
        : live
          ? r.end === null
            ? "Live now"
            : `Live now · closes ${fmtTime(r.end)}`
          : fmtTime(r.start),
    }
  })

  return <HomageScheduleCard rows={cardRows} />
}
