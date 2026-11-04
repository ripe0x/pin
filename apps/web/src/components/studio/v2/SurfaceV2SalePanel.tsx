"use client"

/**
 * Sale settings for a primitive v2 collection: the FixedPriceSale clone in
 * its minter slot (contracts/src/surface/v2/FixedPriceSale.sol). Price,
 * mint window, max mints (this sale's ceiling), wallet cap, payout
 * recipient, and close() (one-way). Authority is borrowed from the
 * collection's owner, so each setter is the owner's transaction. The 5%
 * referral share is a constant on the sale, shown, not edited.
 */

import { useState } from "react"
import { formatEther, isAddress, parseEther, type Abi, type Address } from "viem"
import { useAccount } from "wagmi"
import { fixedPriceSaleAbi } from "@pin/abi"
import { BTN_SECONDARY, ERROR, HELP, INPUT, LABEL } from "@/components/studio/create/wizard-ui"
import { shortAddress } from "@/lib/collection"
import {
  isOwner,
  minterRole,
  mintWindowProblem,
  parseCount,
  saleWindowLabel,
  type SaleV2State,
  type SurfaceV2State,
} from "@/lib/surface-v2-studio"
import { useV2Write } from "./useV2Write"
import { Notice, ReadGrid, Section, TypeToConfirm, WriteError } from "./ui"

const SALE_ABI = fixedPriceSaleAbi as Abi

function toLocalInput(unix: bigint): string {
  if (unix === 0n) return ""
  const d = new Date(Number(unix) * 1000)
  const pad = (n: number) => String(n).padStart(2, "0")
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}
function fromLocalInput(s: string): bigint {
  if (!s.trim()) return 0n
  const ms = new Date(s).getTime()
  return Number.isNaN(ms) ? 0n : BigInt(Math.floor(ms / 1000))
}
function parsePrice(raw: string): bigint | null {
  const t = raw.trim()
  if (t === "" || !/^\d*\.?\d*$/.test(t)) return null
  try {
    return parseEther(t)
  } catch {
    return null
  }
}
function fmtTime(unix: string, none: string): string {
  return unix === "0" ? none : new Date(Number(unix) * 1000).toLocaleString()
}

export function SurfaceV2SalePanel({ state, refetch }: { state: SurfaceV2State; refetch: () => void }) {
  const { address: account } = useAccount()
  const sale = state.sale
  if (!sale) {
    const role = minterRole(state)
    return (
      <Notice tone="amber">
        {role === "owner"
          ? "Your wallet holds the collection's minter slot (an airdrop that has not handed it back), so the public sale is paused. Hand the slot back to the sale under Collection settings, Airdrop."
          : role === "none"
            ? "No minter is set on this collection, so nothing can mint. Point the minter slot at a sale under Collection settings."
            : `The minter (${shortAddress(state.minter!)}) is not a PND fixed-price sale for this collection, so its settings are not managed here.`}
      </Notice>
    )
  }
  const owner = isOwner(state, account)
  const enabled = owner && !sale.closed
  return (
    <div className="space-y-4">
      <ReadGrid
        title="Sale onchain now"
        rows={[
          ["Sale", `${sale.address}${sale.canonical === false ? " (not from the PND sale factory)" : ""}`],
          ["Status", saleWindowLabel(sale, Math.floor(Date.now() / 1000))],
          ["Price", `${formatEther(BigInt(sale.price))} ETH`],
          ["Window", `${fmtTime(sale.mintStart, "open now")} to ${fmtTime(sale.mintEnd, "no end")}`],
          ["Sold", `${sale.totalMinted}${sale.maxMints === "0" ? " (no max)" : ` / ${sale.maxMints} max`}`],
          ["Wallet cap", sale.walletCap === "0" ? "No limit" : sale.walletCap],
          ["Payout", sale.payoutRecipient],
          ["Referral", `${sale.referralShareBps / 100}% fixed, to the referrer a mint names`],
        ]}
      />
      {sale.closed && (
        <Notice>This sale is closed for good. A new sale needs a new sale contract and the minter slot.</Notice>
      )}
      {state.renounced && <Notice>Ownership is renounced, so the sale&apos;s settings are frozen.</Notice>}
      {!state.renounced && !owner && (
        <Notice tone="amber">Connect the collection owner&apos;s wallet to change the sale.</Notice>
      )}
      {!sale.closed && !state.renounced && (
        <>
          <PriceField sale={sale} enabled={enabled} onDone={refetch} />
          <WindowField sale={sale} enabled={enabled} onDone={refetch} />
          <MaxMintsField sale={sale} state={state} enabled={enabled} onDone={refetch} />
          <WalletCapField sale={sale} enabled={enabled} onDone={refetch} />
          <PayoutField sale={sale} enabled={enabled} onDone={refetch} />
          <CloseField sale={sale} name={state.name} enabled={enabled} onDone={refetch} />
        </>
      )}
      <p className="text-[10px] font-mono text-gray-400 leading-relaxed border-t border-gray-100 pt-4">
        The allowlist lives in the Mint gate tool. Supply cap and royalty live on the collection (Collection
        settings).
      </p>
    </div>
  )
}

type FieldProps = { sale: SaleV2State; enabled: boolean; onDone: () => void }

function PriceField({ sale, enabled, onDone }: FieldProps) {
  const [price, setPrice] = useState(formatEther(BigInt(sale.price)))
  const w = useV2Write(onDone)
  const wei = parsePrice(price)
  return (
    <Section title="Price" help="Price per token in ETH. Every mint pays exactly price times quantity; 0 is a gas-only mint.">
      <div className="flex items-end gap-2">
        <label className="block">
          <span className={LABEL}>Price (ETH)</span>
          <input value={price} onChange={(e) => setPrice(e.target.value)} inputMode="decimal" className={`${INPUT} w-40`} />
        </label>
        <button
          type="button"
          disabled={!enabled || wei === null || w.busy}
          onClick={() => wei !== null && w.run({ address: sale.address, abi: SALE_ABI, functionName: "setPrice", args: [wei] })}
          className={BTN_SECONDARY}
        >
          {w.label ?? "Save price"}
        </button>
      </div>
      {wei === null && price.trim() !== "" && <p className={ERROR}>Enter an ETH amount, 0 or more.</p>}
      <WriteError error={w.error} action="Set price" />
    </Section>
  )
}

function WindowField({ sale, enabled, onDone }: FieldProps) {
  const [start, setStart] = useState(toLocalInput(BigInt(sale.mintStart)))
  const [end, setEnd] = useState(toLocalInput(BigInt(sale.mintEnd)))
  const w = useV2Write(onDone)
  const s = fromLocalInput(start)
  const e = fromLocalInput(end)
  const problem = mintWindowProblem(s, e)
  return (
    <Section title="Mint window" help="When the sale is open. Leave start empty to open now, end empty for no end. Reopen the window here for a new batch.">
      <div className="flex flex-wrap items-end gap-2">
        <label className="block">
          <span className={LABEL}>Start</span>
          <input type="datetime-local" value={start} onChange={(ev) => setStart(ev.target.value)} className={INPUT} />
        </label>
        <label className="block">
          <span className={LABEL}>End</span>
          <input type="datetime-local" value={end} onChange={(ev) => setEnd(ev.target.value)} className={INPUT} />
        </label>
        <button
          type="button"
          disabled={!enabled || !!problem || w.busy}
          onClick={() => w.run({ address: sale.address, abi: SALE_ABI, functionName: "setMintWindow", args: [s, e] })}
          className={BTN_SECONDARY}
        >
          {w.label ?? "Save window"}
        </button>
      </div>
      {problem && <p className={ERROR}>{problem}</p>}
      <WriteError error={w.error} action="Set window" />
    </Section>
  )
}

function MaxMintsField({ sale, state, enabled, onDone }: FieldProps & { state: SurfaceV2State }) {
  const [max, setMax] = useState(sale.maxMints === "0" ? "" : sale.maxMints)
  const w = useV2Write(onDone)
  const v = parseCount(max)
  return (
    <Section
      title="Max mints through this sale"
      help="A running total of mints this sale may ever make, not a per-batch number. To release N more, set it to the number sold plus N. Empty means no limit. Owner airdrops do not count here; the collection's supply cap bounds everything."
    >
      <div className="flex items-end gap-2">
        <label className="block">
          <span className={LABEL}>Max mints</span>
          <input value={max} onChange={(e) => setMax(e.target.value)} inputMode="numeric" placeholder="no limit" className={`${INPUT} w-40`} />
        </label>
        <button
          type="button"
          disabled={!enabled || v === null || w.busy}
          onClick={() => v !== null && w.run({ address: sale.address, abi: SALE_ABI, functionName: "setMaxMints", args: [v] })}
          className={BTN_SECONDARY}
        >
          {w.label ?? "Save max mints"}
        </button>
      </div>
      {v === null && <p className={ERROR}>Enter a whole number, or leave empty.</p>}
      <p className={HELP}>
        {sale.totalMinted} sold through this sale, {state.minted} minted in all. Supply cap:{" "}
        {state.supplyCap === "0" ? "open" : state.supplyCap}.
      </p>
      <WriteError error={w.error} action="Set max mints" />
    </Section>
  )
}

function WalletCapField({ sale, enabled, onDone }: FieldProps) {
  const [cap, setCap] = useState(sale.walletCap === "0" ? "" : sale.walletCap)
  const w = useV2Write(onDone)
  const v = parseCount(cap)
  return (
    <Section title="Wallet cap" help="The most tokens one recipient can get through this sale, across all their mints. Empty means no limit.">
      <div className="flex items-end gap-2">
        <label className="block">
          <span className={LABEL}>Per wallet</span>
          <input value={cap} onChange={(e) => setCap(e.target.value)} inputMode="numeric" placeholder="no limit" className={`${INPUT} w-40`} />
        </label>
        <button
          type="button"
          disabled={!enabled || v === null || w.busy}
          onClick={() => v !== null && w.run({ address: sale.address, abi: SALE_ABI, functionName: "setWalletCap", args: [v] })}
          className={BTN_SECONDARY}
        >
          {w.label ?? "Save wallet cap"}
        </button>
      </div>
      {v === null && <p className={ERROR}>Enter a whole number, or leave empty.</p>}
      <WriteError error={w.error} action="Set wallet cap" />
    </Section>
  )
}

function PayoutField({ sale, enabled, onDone }: FieldProps) {
  const [payout, setPayout] = useState<string>(sale.payoutRecipient)
  const w = useV2Write(onDone)
  const t = payout.trim()
  const valid = isAddress(t) && !/^0x0{40}$/i.test(t)
  return (
    <Section title="Payout recipient" help="Where this sale's proceeds accrue. Balances already earned stay with the old recipient.">
      <div className="flex items-end gap-2">
        <label className="block flex-1">
          <span className={LABEL}>Recipient</span>
          <input value={payout} onChange={(e) => setPayout(e.target.value)} spellCheck={false} className={INPUT} />
        </label>
        <button
          type="button"
          disabled={!enabled || !valid || w.busy}
          onClick={() => w.run({ address: sale.address, abi: SALE_ABI, functionName: "setPayoutRecipient", args: [t as Address] })}
          className={BTN_SECONDARY}
        >
          {w.label ?? "Save payout"}
        </button>
      </div>
      {t !== "" && !valid && <p className={ERROR}>Not a valid address.</p>}
      <WriteError error={w.error} action="Set payout" />
    </Section>
  )
}

function CloseField({ sale, name, enabled, onDone }: FieldProps & { name: string }) {
  const w = useV2Write(onDone)
  return (
    <Section
      title="Close the sale"
      help="Stops this sale for good: no mint can go through it again, whatever its window says. Payouts stay withdrawable. Reopening later takes a new sale contract and the minter slot."
    >
      <TypeToConfirm
        name={name}
        label="Close sale"
        busyLabel={w.label}
        busy={w.busy}
        disabled={!enabled}
        onConfirm={() => w.run({ address: sale.address, abi: SALE_ABI, functionName: "close", args: [] })}
      />
      <WriteError error={w.error} action="Close sale" />
    </Section>
  )
}
