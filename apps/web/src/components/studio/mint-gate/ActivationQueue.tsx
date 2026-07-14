"use client"

/**
 * Wallet-driven onchain activation for the mint gate: three independent
 * transactions (attach the hook, activate the published root, set the
 * per-wallet cap) plus a detach path, each its own useWriteContract +
 * useWaitForTransactionReceipt pair so their pending/success states don't
 * collide. Every confirmed tx calls `onConfirmed`, which the parent uses
 * to re-read gate state through the cached API (never a fresh client-side
 * chain read here).
 */

import { useEffect, useState } from "react"
import { useChainId, useWaitForTransactionReceipt, useWriteContract } from "wagmi"
import { surfaceAbi, gateHookAbi } from "@pin/abi"
import { formatWriteError } from "@/components/tx/tx-ui"
import { BTN, BTN_SECONDARY, ERROR, INPUT } from "@/components/studio/create/wizard-ui"
import { ZERO_ADDRESS, gateHookAddress, shortAddress } from "@/lib/collection"
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
  collection,
  derived,
  publishedRoot,
  onConfirmed,
}: {
  collection: `0x${string}`
  derived: DerivedGate | null
  publishedRoot: `0x${string}` | null
  onConfirmed: () => void
}) {
  const chainId = useChainId()
  const gateHook = gateHookAddress(chainId)

  // Step 1: attach the hook.
  const attach = useWriteContract()
  const attachReceipt = useWaitForTransactionReceipt({ hash: attach.data })
  useEffect(() => {
    if (attachReceipt.isSuccess) onConfirmed()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attachReceipt.isSuccess])

  // Step 2: activate the published root.
  const activate = useWriteContract()
  const activateReceipt = useWaitForTransactionReceipt({ hash: activate.data })
  useEffect(() => {
    if (activateReceipt.isSuccess) onConfirmed()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activateReceipt.isSuccess])

  // Step 3: set the per-wallet cap.
  const [capInput, setCapInput] = useState("0")
  const setCapWrite = useWriteContract()
  const setCapReceipt = useWaitForTransactionReceipt({ hash: setCapWrite.data })
  useEffect(() => {
    if (setCapReceipt.isSuccess) onConfirmed()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [setCapReceipt.isSuccess])
  const capNum = Number(capInput)
  const capValid = capInput.trim() !== "" && Number.isInteger(capNum) && capNum >= 0

  // Remove: detach the hook. Confirm-by-second-click, no browser dialog —
  // first click arms the button, second click (within a short window)
  // fires the tx.
  const [removeArmed, setRemoveArmed] = useState(false)
  const remove = useWriteContract()
  const removeReceipt = useWaitForTransactionReceipt({ hash: remove.data })
  useEffect(() => {
    if (removeReceipt.isSuccess) {
      setRemoveArmed(false)
      onConfirmed()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [removeReceipt.isSuccess])
  useEffect(() => {
    if (!removeArmed) return
    const t = setTimeout(() => setRemoveArmed(false), 6000)
    return () => clearTimeout(t)
  }, [removeArmed])

  if (!gateHook) {
    return <p className={ERROR}>No GateHook is configured for this network.</p>
  }

  const hookAttached = derived?.hookAttached ?? false
  const otherHookAddress = derived?.otherHookAddress ?? null
  const activeRoot = derived?.root ?? ZERO_ROOT
  const rootActive = !!publishedRoot && publishedRoot.toLowerCase() === activeRoot.toLowerCase()
  const someHookAttached = hookAttached || !!otherHookAddress

  return (
    <div className="space-y-4">
      <header className="space-y-1.5">
        <h3 className="text-sm font-medium">Activate onchain</h3>
        <p className="text-xs text-gray-500 leading-relaxed">
          Each step is its own transaction, signed by this collection&apos;s
          owner or an admin. Nothing above is granted until it lands here.
        </p>
      </header>

      <WriteStep
        step={1}
        title="Attach the gate hook"
        description={
          otherHookAddress
            ? `This collection currently uses a different hook (${shortAddress(otherHookAddress)}). Attaching GateHook replaces it.`
            : "Point this collection's mint hook at the shared GateHook contract."
        }
        ctaLabel={otherHookAddress ? "Replace hook with GateHook" : "Attach gate hook"}
        pendingLabel="Attaching…"
        done={hookAttached}
        disabled={false}
        onRun={() =>
          attach.writeContract({
            address: collection,
            abi: surfaceAbi,
            functionName: "setMintHook",
            args: [gateHook],
          })
        }
        isPending={attach.isPending}
        isMining={attachReceipt.isLoading}
        error={attach.error}
      />

      <WriteStep
        step={2}
        title="Activate the published list"
        description={
          publishedRoot
            ? "Set the published root as the active allowlist on GateHook."
            : "Publish a list above first."
        }
        ctaLabel="Activate published list"
        pendingLabel="Activating…"
        done={rootActive}
        disabled={!publishedRoot}
        onRun={() => {
          if (!publishedRoot) return
          activate.writeContract({
            address: gateHook,
            abi: gateHookAbi,
            functionName: "setRoot",
            args: [collection, publishedRoot],
          })
        }}
        isPending={activate.isPending}
        isMining={activateReceipt.isLoading}
        error={activate.error}
      />

      <div className="rounded border border-gray-200 p-3 space-y-2">
        <div className="space-y-0.5">
          <p className="text-[10px] font-mono uppercase tracking-wider text-gray-400">Step 3</p>
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
                address: gateHook,
                abi: gateHookAbi,
                functionName: "setCap",
                args: [collection, BigInt(capNum)],
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

      {someHookAttached && (
        <div className="rounded border border-gray-200 p-3 space-y-2">
          <div className="space-y-0.5">
            <p className="text-[10px] font-mono uppercase tracking-wider text-gray-400">Remove the gate</p>
            <p className="text-xs text-gray-500 leading-relaxed">
              Detaches the mint hook entirely. The mint opens to anyone,
              subject to any other sale settings.
            </p>
          </div>
          <button
            type="button"
            onClick={() => {
              if (!removeArmed) {
                setRemoveArmed(true)
                return
              }
              remove.writeContract({
                address: collection,
                abi: surfaceAbi,
                functionName: "setMintHook",
                args: [ZERO_ADDRESS],
              })
            }}
            disabled={remove.isPending || removeReceipt.isLoading}
            className={BTN_SECONDARY}
          >
            {remove.isPending
              ? "Confirm in wallet…"
              : removeReceipt.isLoading
                ? "Removing…"
                : removeArmed
                  ? "Click again to confirm removal"
                  : "Remove the gate"}
          </button>
          {remove.error && <p className={ERROR}>{formatWriteError(remove.error, "Remove")}</p>}
        </div>
      )}
    </div>
  )
}
