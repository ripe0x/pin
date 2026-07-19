"use client"

/**
 * Wallet-driven onchain activation for the mint gate: two independent
 * transactions (activate the published root, set the per-wallet cap)
 * directly on the collection's canonical FixedPriceMinter clone, each its
 * own useWriteContract + useWaitForTransactionReceipt pair so their
 * pending/success states don't collide. There is no "attach a hook" step
 * anymore (thin-token rearchitecture): allowlist + wallet-cap config live
 * on the minter itself, not a separately-attached hook contract. Every
 * confirmed tx calls `onConfirmed`, which the parent uses to re-read gate
 * state through the cached API (never a fresh client-side chain read here).
 */

import { useEffect, useState } from "react"
import { useWaitForTransactionReceipt, useWriteContract } from "wagmi"
import { fixedPriceMinterAbi } from "@pin/abi"
import { formatWriteError } from "@/components/tx/tx-ui"
import { BTN, BTN_SECONDARY, ERROR, INPUT } from "@/components/studio/create/wizard-ui"
import { type DerivedGate, ZERO_ROOT } from "./gate-api"

function WriteStep({
  step,
  title,
  description,
  ctaLabel,
  pendingLabel,
  done,
  disabled,
  onRun,
  isPending,
  isMining,
  error,
}: {
  step: number
  title: string
  description: string
  ctaLabel: string
  pendingLabel: string
  done: boolean
  disabled: boolean
  onRun: () => void
  isPending: boolean
  isMining: boolean
  error: unknown
}) {
  return (
    <div className="rounded border border-gray-200 p-3 space-y-2">
      <div className="flex items-start justify-between gap-3">
        <div className="space-y-0.5 min-w-0">
          <p className="text-[10px] font-mono uppercase tracking-wider text-gray-400">Step {step}</p>
          <p className="text-sm font-medium">{title}</p>
          <p className="text-xs text-gray-500 leading-relaxed">{description}</p>
        </div>
        {done && (
          <span className="shrink-0 text-[10px] font-mono uppercase tracking-wider text-status-available">
            Done ✓
          </span>
        )}
      </div>
      {!done && (
        <button type="button" onClick={onRun} disabled={disabled || isPending || isMining} className={BTN}>
          {isPending ? "Confirm in wallet…" : isMining ? pendingLabel : ctaLabel}
        </button>
      )}
      {error !== undefined && error !== null && <p className={ERROR}>{formatWriteError(error, title)}</p>}
    </div>
  )
}

export function ActivationQueue({
  derived,
  publishedRoot,
  onConfirmed,
}: {
  derived: DerivedGate | null
  publishedRoot: `0x${string}` | null
  onConfirmed: () => void
}) {
  const minter = derived?.minter ?? null

  // Step 1: activate the published root directly on the minter.
  const activate = useWriteContract()
  const activateReceipt = useWaitForTransactionReceipt({ hash: activate.data })
  useEffect(() => {
    if (activateReceipt.isSuccess) onConfirmed()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activateReceipt.isSuccess])

  // Step 2: set the per-wallet cap.
  const [capInput, setCapInput] = useState("0")
  const setCapWrite = useWriteContract()
  const setCapReceipt = useWaitForTransactionReceipt({ hash: setCapWrite.data })
  useEffect(() => {
    if (setCapReceipt.isSuccess) onConfirmed()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [setCapReceipt.isSuccess])
  const capNum = Number(capInput)
  const capValid = capInput.trim() !== "" && Number.isInteger(capNum) && capNum >= 0

  // Clear: reset the allowlist root to zero (open mint, subject to any
  // other sale settings). Confirm-by-second-click, no browser dialog —
  // first click arms the button, second click (within a short window)
  // fires the tx.
  const [clearArmed, setClearArmed] = useState(false)
  const clear = useWriteContract()
  const clearReceipt = useWaitForTransactionReceipt({ hash: clear.data })
  useEffect(() => {
    if (clearReceipt.isSuccess) {
      setClearArmed(false)
      onConfirmed()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clearReceipt.isSuccess])
  useEffect(() => {
    if (!clearArmed) return
    const t = setTimeout(() => setClearArmed(false), 6000)
    return () => clearTimeout(t)
  }, [clearArmed])

  if (!minter) {
    return (
      <p className={ERROR}>
        No canonical minter is on record for this collection yet. The mint
        gate lives on the minter FixedPriceMinter wired at deploy — a
        bring-your-own minter, or a collection not yet indexed, has no gate
        to activate here.
      </p>
    )
  }

  const activeRoot = derived?.root ?? ZERO_ROOT
  const rootActive = !!publishedRoot && publishedRoot.toLowerCase() === activeRoot.toLowerCase()
  const gateSet = activeRoot !== ZERO_ROOT

  return (
    <div className="space-y-4">
      <header className="space-y-1.5">
        <h3 className="text-sm font-medium">Activate onchain</h3>
        <p className="text-xs text-gray-500 leading-relaxed">
          Each step is its own transaction, signed by this collection&apos;s
          owner or an admin, written directly to the minter. Nothing above is
          granted until it lands here.
        </p>
      </header>

      <WriteStep
        step={1}
        title="Activate the published list"
        description={
          publishedRoot
            ? "Set the published root as the minter's active allowlist."
            : "Publish a list above first."
        }
        ctaLabel="Activate published list"
        pendingLabel="Activating…"
        done={rootActive}
        disabled={!publishedRoot}
        onRun={() => {
          if (!publishedRoot) return
          activate.writeContract({
            address: minter,
            abi: fixedPriceMinterAbi,
            functionName: "setAllowlistRoot",
            args: [publishedRoot],
          })
        }}
        isPending={activate.isPending}
        isMining={activateReceipt.isLoading}
        error={activate.error}
      />

      <div className="rounded border border-gray-200 p-3 space-y-2">
        <div className="space-y-0.5">
          <p className="text-[10px] font-mono uppercase tracking-wider text-gray-400">Step 2</p>
          <p className="text-sm font-medium">Per-wallet limit</p>
          <p className="text-xs text-gray-500 leading-relaxed">
            Maximum tokens any one wallet may mint while the cap is set. 0
            means no limit.
          </p>
        </div>
        <div className="flex items-stretch gap-2">
          <input
            type="number"
            min={0}
            step={1}
            inputMode="numeric"
            value={capInput}
            onChange={(e) => setCapInput(e.target.value)}
            disabled={setCapWrite.isPending || setCapReceipt.isLoading}
            className={`${INPUT} w-28`}
          />
          <button
            type="button"
            onClick={() =>
              setCapWrite.writeContract({
                address: minter,
                abi: fixedPriceMinterAbi,
                functionName: "setWalletCap",
                args: [BigInt(capNum)],
              })
            }
            disabled={!capValid || setCapWrite.isPending || setCapReceipt.isLoading}
            className={BTN_SECONDARY}
          >
            {setCapWrite.isPending ? "Confirm in wallet…" : setCapReceipt.isLoading ? "Setting…" : "Set cap"}
          </button>
        </div>
        {capInput.trim() !== "" && !capValid && <p className={ERROR}>Enter a whole number, 0 or more.</p>}
        {derived && (
          <p className="text-[10px] font-mono text-gray-400">
            Active cap: {derived.cap === "0" ? "no limit" : derived.cap}
          </p>
        )}
        {setCapWrite.error && <p className={ERROR}>{formatWriteError(setCapWrite.error, "Set cap")}</p>}
      </div>

      {gateSet && (
        <div className="rounded border border-gray-200 p-3 space-y-2">
          <div className="space-y-0.5">
            <p className="text-[10px] font-mono uppercase tracking-wider text-gray-400">Remove the gate</p>
            <p className="text-xs text-gray-500 leading-relaxed">
              Resets the allowlist root to zero. The mint opens to anyone,
              subject to any other sale settings.
            </p>
          </div>
          <button
            type="button"
            onClick={() => {
              if (!clearArmed) {
                setClearArmed(true)
                return
              }
              clear.writeContract({
                address: minter,
                abi: fixedPriceMinterAbi,
                functionName: "setAllowlistRoot",
                args: [ZERO_ROOT],
              })
            }}
            disabled={clear.isPending || clearReceipt.isLoading}
            className={BTN_SECONDARY}
          >
            {clear.isPending
              ? "Confirm in wallet…"
              : clearReceipt.isLoading
                ? "Removing…"
                : clearArmed
                  ? "Click again to confirm removal"
                  : "Remove the gate"}
          </button>
          {clear.error && <p className={ERROR}>{formatWriteError(clear.error, "Remove")}</p>}
        </div>
      )}
    </div>
  )
}
