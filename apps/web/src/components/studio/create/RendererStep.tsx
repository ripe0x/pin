"use client"

/**
 * Step 1: the artist's already-deployed renderer contract. Validates the
 * address (syntax, then bytecode) — that's all that can be checked before a
 * collection exists. previewURI takes the collection as a parameter and
 * reads its onchain state (see ScriptyRenderer.previewURI,
 * contracts/src/surface/templates/ScriptyRenderer.sol), so it always
 * reverts against a not-yet-deployed collection; the preview call happens
 * on the done screen in DeployStep, against the real collection address,
 * once it exists.
 *
 * The check is debounced off the typed address and cached per (chainId,
 * address) for the component's lifetime, so pasting the same address twice,
 * or backspacing and retyping, doesn't refire the RPC call.
 */

import { useEffect, useRef, useState } from "react"
import { type Address } from "viem"
import { usePublicClient, useChainId } from "wagmi"
import { hasBytecode, rendererAddressSyntax } from "@/lib/create-collection"
import type { WizardState } from "./types"
import { LABEL, INPUT, HELP, ERROR, BTN } from "./wizard-ui"

const DEBOUNCE_MS = 400

type CheckState = "idle" | "checking" | "no-contract" | "unreachable" | "ready"

export function RendererStep({
  state,
  set,
  onNext,
}: {
  state: WizardState
  set: <K extends keyof WizardState>(key: K, value: WizardState[K]) => void
  onNext: () => void
}) {
  const publicClient = usePublicClient()
  const chainId = useChainId()
  const [check, setCheck] = useState<CheckState>("idle")
  const cache = useRef(new Map<string, CheckState>())

  const trimmed = state.rendererAddress.trim()
  const syntax = rendererAddressSyntax(trimmed)

  useEffect(() => {
    if (syntax !== "valid" || !publicClient) {
      setCheck("idle")
      return
    }
    const key = `${chainId}:${trimmed.toLowerCase()}`
    const cached = cache.current.get(key)
    if (cached) {
      setCheck(cached)
      return
    }

    let cancelled = false
    setCheck("checking")
    const timer = setTimeout(() => {
      void (async () => {
        let result: CheckState
        try {
          const code = await publicClient.getBytecode({ address: trimmed as Address })
          result = hasBytecode(code) ? "ready" : "no-contract"
        } catch {
          result = "unreachable"
        }
        if (!cancelled) {
          cache.current.set(key, result)
          setCheck(result)
        }
      })()
    }, DEBOUNCE_MS)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [trimmed, syntax, chainId, publicClient])

  const canProceed = syntax === "valid" && check === "ready"

  return (
    <div className="space-y-5">
      <header className="space-y-1.5">
        <h3 className="text-sm font-medium">Renderer</h3>
        <p className="text-xs text-gray-500 leading-relaxed">
          The contract address of the renderer you already deployed. It
          implements tokenURI and reads this collection&rsquo;s onchain state
          directly.
        </p>
      </header>

      <div>
        <label className={LABEL} htmlFor="cc-renderer">
          Renderer contract address
        </label>
        <input
          id="cc-renderer"
          className={INPUT}
          value={state.rendererAddress}
          onChange={(e) => set("rendererAddress", e.target.value.trim())}
          placeholder="0x…"
        />
        {syntax === "invalid" && <p className={ERROR}>Invalid address.</p>}
        {check === "checking" && <p className={HELP}>Checking renderer contract…</p>}
        {check === "no-contract" && <p className={ERROR}>No contract found at this address.</p>}
        {check === "unreachable" && (
          <p className={ERROR}>Could not read this address. Check your network and try again.</p>
        )}
        {check === "ready" && (
          <p className={HELP}>
            Contract found. You will see a preview of one seed after deploy,
            before the first mint.
          </p>
        )}
      </div>

      <button onClick={onNext} disabled={!canProceed} className={BTN}>
        Continue
      </button>
    </div>
  )
}
