"use client"

/**
 * One collection's sale settings: read the canonical minter's current config
 * (via the cached /sale API, no client chain read) and edit it through the
 * minter's owner-only setters — price, mint window, max mints, payout,
 * referral share. Each field is its own wallet tx (useWriteContract +
 * receipt) written straight to the minter; owner/admin authority is enforced
 * onchain (onlyCollectionOwnerOrAdmin), so a non-owner's tx reverts. Every
 * confirmed tx refetches the cached state.
 */

import { useCallback, useEffect, useState } from "react"
import { formatEther, parseEther, isAddress, type Address } from "viem"
import { useWaitForTransactionReceipt, useWriteContract } from "wagmi"
import { fixedPriceMinterAbi } from "@pin/abi"
import { formatWriteError } from "@/components/tx/tx-ui"
import { BTN_SECONDARY, ERROR, HELP, INPUT, LABEL } from "@/components/studio/create/wizard-ui"
import { fetchSaleState, type SaleState } from "./sale-api"

/** unix seconds -> "YYYY-MM-DDTHH:mm" in local time for a datetime-local input. */
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

function useSetter(minter: Address | null, onConfirmed: () => void) {
  const write = useWriteContract()
  const receipt = useWaitForTransactionReceipt({ hash: write.data })
  useEffect(() => {
    if (receipt.isSuccess) onConfirmed()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [receipt.isSuccess])
  const busy = write.isPending || receipt.isLoading
  const label = write.isPending ? "Confirm in wallet…" : receipt.isLoading ? "Saving…" : "Save"
  const run = (functionName: string, args: readonly unknown[]) => {
    if (!minter) return
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    write.writeContract({ address: minter, abi: fixedPriceMinterAbi, functionName: functionName as any, args: args as any })
  }
  return { run, busy, label, error: write.error }
}

function Field({
  title,
  help,
  children,
}: {
  title: string
  help: string
  children: React.ReactNode
}) {
  return (
    <div className="rounded border border-gray-200 p-3 space-y-2">
      <div className="space-y-0.5">
        <p className="text-sm font-medium">{title}</p>
        <p className="text-xs text-gray-500 leading-relaxed">{help}</p>
      </div>
      {children}
    </div>
  )
}

export function SaleSettingsPanel({ collection }: { collection: `0x${string}` }) {
  const [state, setState] = useState<SaleState | null | undefined>(undefined)
  const refetch = useCallback(() => {
    setState(undefined)
    void fetchSaleState(collection).then(setState)
  }, [collection])
  useEffect(() => {
    refetch()
  }, [refetch])

  const loading = state === undefined
  const minter = state?.minter ?? null
  const sale = state?.sale ?? null

  // Local form fields, seeded from current state.
  const [price, setPrice] = useState("")
  const [start, setStart] = useState("")
  const [end, setEnd] = useState("")
  const [maxMints, setMaxMints] = useState("")
  const [payout, setPayout] = useState("")
  const [referral, setReferral] = useState("")

  useEffect(() => {
    if (!sale) return
    setPrice(formatEther(BigInt(sale.price)))
    setStart(toLocalInput(BigInt(sale.mintStart)))
    setEnd(toLocalInput(BigInt(sale.mintEnd)))
    setMaxMints(sale.maxMints === "0" ? "" : sale.maxMints)
    setPayout(sale.payout)
    setReferral(String(sale.referralShareBps))
  }, [sale])

  const priceSetter = useSetter(minter, refetch)
  const windowSetter = useSetter(minter, refetch)
  const maxSetter = useSetter(minter, refetch)
  const payoutSetter = useSetter(minter, refetch)
  const referralSetter = useSetter(minter, refetch)

  if (loading) {
    return <p className="text-[11px] font-mono text-gray-400">Reading current sale settings…</p>
  }
  if (!minter) {
    return (
      <p className={ERROR}>
        No canonical minter is on record for this collection. Sale settings
        live on the FixedPriceMinter wired at deploy — a bring-your-own minter
        has its own configuration surface.
      </p>
    )
  }

  const priceValid = price.trim() !== "" && !Number.isNaN(Number(price)) && Number(price) >= 0
  const startU = fromLocalInput(start)
  const endU = fromLocalInput(end)
  const windowValid = endU === 0n || startU === 0n || endU > startU
  const maxValid = maxMints.trim() === "" || (Number.isInteger(Number(maxMints)) && Number(maxMints) >= 0)
  const payoutValid = payout.trim() === "" || isAddress(payout.trim())
  const referralValid =
    referral.trim() !== "" && Number.isInteger(Number(referral)) && Number(referral) >= 0 && Number(referral) <= 10_000

  return (
    <div className="space-y-4">
      <p className="text-xs text-gray-500 leading-relaxed">
        Each setting is its own transaction, signed by this collection&apos;s
        owner or an admin and written to the canonical minter. Changes are
        live immediately; the current values above may take up to twenty
        seconds to reflect a tx you just confirmed.
      </p>

      <Field title="Price" help="Price per token, in ETH. 0 is a gas-only mint.">
        <div className="flex items-stretch gap-2">
          <input
            value={price}
            onChange={(e) => setPrice(e.target.value)}
            inputMode="decimal"
            placeholder="0.01"
            className={`${INPUT} w-40`}
          />
          <span className="flex items-center text-[10px] font-mono uppercase tracking-wider text-gray-400">ETH</span>
          <button
            type="button"
            disabled={!priceValid || priceSetter.busy}
            onClick={() => priceSetter.run("setPrice", [parseEther(price.trim())])}
            className={BTN_SECONDARY}
          >
            {priceSetter.label}
          </button>
        </div>
        {!priceValid && price.trim() !== "" && <p className={ERROR}>Enter an ETH amount, 0 or more.</p>}
        {priceSetter.error && <p className={ERROR}>{formatWriteError(priceSetter.error, "Set price")}</p>}
      </Field>

      <Field
        title="Mint window"
        help="When the mint is open. Leave a field empty for open-now / no-end. For a batch, reopen the window here."
      >
        <div className="flex flex-wrap items-end gap-2">
          <label className="block">
            <span className={LABEL}>Start</span>
            <input type="datetime-local" value={start} onChange={(e) => setStart(e.target.value)} className={INPUT} />
          </label>
          <label className="block">
            <span className={LABEL}>End</span>
            <input type="datetime-local" value={end} onChange={(e) => setEnd(e.target.value)} className={INPUT} />
          </label>
          <button
            type="button"
            disabled={!windowValid || windowSetter.busy}
            onClick={() => windowSetter.run("setMintWindow", [startU, endU])}
            className={BTN_SECONDARY}
          >
            {windowSetter.label}
          </button>
        </div>
        {!windowValid && <p className={ERROR}>End must be after start.</p>}
        {windowSetter.error && <p className={ERROR}>{formatWriteError(windowSetter.error, "Set window")}</p>}
      </Field>

      <Field
        title="Max mints"
        help="This minter's own sale ceiling, separate from the collection's supply cap. Empty = no limit. Raise it to open the next batch."
      >
        <div className="flex items-stretch gap-2">
          <input
            value={maxMints}
            onChange={(e) => setMaxMints(e.target.value)}
            inputMode="numeric"
            placeholder="no limit"
            className={`${INPUT} w-40`}
          />
          <button
            type="button"
            disabled={!maxValid || maxSetter.busy}
            onClick={() => maxSetter.run("setMaxMints", [maxMints.trim() === "" ? 0n : BigInt(Number(maxMints))])}
            className={BTN_SECONDARY}
          >
            {maxSetter.label}
          </button>
        </div>
        {!maxValid && <p className={ERROR}>Enter a whole number, or leave empty.</p>}
        {sale && (
          <p className={HELP}>
            Supply cap: {state?.supplyCap === "0" ? "open" : state?.supplyCap} · minted: {state?.minted}
          </p>
        )}
        {maxSetter.error && <p className={ERROR}>{formatWriteError(maxSetter.error, "Set max mints")}</p>}
      </Field>

      <Field title="Payout recipient" help="Where mint proceeds go. Defaults to the collection owner when set to the zero address.">
        <div className="flex items-stretch gap-2">
          <input
            value={payout}
            onChange={(e) => setPayout(e.target.value)}
            spellCheck={false}
            placeholder="0x…"
            className={`${INPUT} flex-1`}
          />
          <button
            type="button"
            disabled={!payoutValid || payout.trim() === "" || payoutSetter.busy}
            onClick={() => payoutSetter.run("setPayoutRecipient", [payout.trim() as Address])}
            className={BTN_SECONDARY}
          >
            {payoutSetter.label}
          </button>
        </div>
        {!payoutValid && <p className={ERROR}>Not a valid address.</p>}
        {payoutSetter.error && <p className={ERROR}>{formatWriteError(payoutSetter.error, "Set payout")}</p>}
      </Field>

      <Field
        title="Referral share"
        help="Basis points of the price paid to a referrer on referred mints (100 = 1%). Capped by the minter; an over-cap value reverts."
      >
        <div className="flex items-stretch gap-2">
          <input
            value={referral}
            onChange={(e) => setReferral(e.target.value)}
            inputMode="numeric"
            placeholder="0"
            className={`${INPUT} w-40`}
          />
          <span className="flex items-center text-[10px] font-mono uppercase tracking-wider text-gray-400">bps</span>
          <button
            type="button"
            disabled={!referralValid || referralSetter.busy}
            onClick={() => referralSetter.run("setReferralShareBps", [Number(referral)])}
            className={BTN_SECONDARY}
          >
            {referralSetter.label}
          </button>
        </div>
        {!referralValid && <p className={ERROR}>Enter a whole number of basis points, 0–10000.</p>}
        {referralSetter.error && <p className={ERROR}>{formatWriteError(referralSetter.error, "Set referral share")}</p>}
      </Field>

      <p className="text-[10px] font-mono text-gray-400 leading-relaxed border-t border-gray-100 pt-4">
        Allowlist and per-wallet cap live in the Mint gate tool. Supply cap and
        royalty are set on the collection at deploy.
      </p>
    </div>
  )
}
