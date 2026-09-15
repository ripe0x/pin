"use client"

/**
 * Step 1: the artist's already-deployed renderer contract. Validates the
 * address (syntax, then bytecode, then an optional previewURI probe) and
 * shows a live preview when the renderer supports it. A renderer with no
 * preview support still deploys fine — IRenderer declares no ERC-165
 * interface id (see contracts/src/surface/interfaces/IRenderer.sol), so
 * detection here is bytecode-exists plus a try/catch previewURI call,
 * matching the repo's feature-probing convention, not supportsInterface.
 *
 * The check is debounced off the typed address and cached per (chainId,
 * address) for the component's lifetime, so pasting the same address twice,
 * or backspacing and retyping, doesn't refire the RPC calls.
 */

import { useEffect, useRef, useState } from "react"
import { isAddress, type Address } from "viem"
import { usePublicClient, useChainId } from "wagmi"
import { iPreviewRendererAbi } from "@pin/abi"
import { ZERO_ADDRESS, ipfsToHttp } from "@/lib/collection"
import {
  decodePreviewURI,
  hasBytecode,
  rendererAddressSyntax,
  type PreviewDecodeResult,
} from "@/lib/create-collection"
import type { WizardState } from "./types"
import { LABEL, INPUT, HELP, ERROR, BTN } from "./wizard-ui"

const DEBOUNCE_MS = 400
const PREVIEW_TOKEN_ID = 1n

type CheckState =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "no-contract" }
  | { kind: "unreachable" }
  | { kind: "ready"; preview: PreviewDecodeResult }

function randomSeed(): `0x${string}` {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  return `0x${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`
}

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
  const [check, setCheck] = useState<CheckState>({ kind: "idle" })
  const cache = useRef(new Map<string, CheckState>())

  const trimmed = state.rendererAddress.trim()
  const syntax = rendererAddressSyntax(trimmed)

  useEffect(() => {
    if (syntax !== "valid" || !publicClient) {
      setCheck({ kind: "idle" })
      return
    }
    const key = `${chainId}:${trimmed.toLowerCase()}`
    const cached = cache.current.get(key)
    if (cached) {
      setCheck(cached)
      return
    }

    let cancelled = false
    setCheck({ kind: "checking" })
    const timer = setTimeout(() => {
      void (async () => {
        let result: CheckState
        try {
          const code = await publicClient.getBytecode({ address: trimmed as Address })
          if (!hasBytecode(code)) {
            result = { kind: "no-contract" }
          } else {
            let preview: PreviewDecodeResult = { kind: "unsupported" }
            try {
              const uri = await publicClient.readContract({
                address: trimmed as Address,
                abi: iPreviewRendererAbi,
                functionName: "previewURI",
                args: [ZERO_ADDRESS as Address, PREVIEW_TOKEN_ID, randomSeed()],
              })
              preview = decodePreviewURI(uri)
            } catch {
              // No previewURI, or it reverted — deploy stays allowed either way.
            }
            result = { kind: "ready", preview }
          }
        } catch {
          result = { kind: "unreachable" }
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

  const canProceed = syntax === "valid" && check.kind === "ready"

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
        {check.kind === "checking" && <p className={HELP}>Checking renderer contract…</p>}
        {check.kind === "no-contract" && (
          <p className={ERROR}>No contract found at this address.</p>
        )}
        {check.kind === "unreachable" && (
          <p className={ERROR}>Could not read this address. Check your network and try again.</p>
        )}
      </div>

      {check.kind === "ready" && <PreviewPane preview={check.preview} />}

      <button onClick={onNext} disabled={!canProceed} className={BTN}>
        Continue
      </button>
    </div>
  )
}

function PreviewPane({ preview }: { preview: PreviewDecodeResult }) {
  if (preview.kind === "unsupported") {
    return <p className={HELP}>This renderer has no preview. You can still deploy.</p>
  }
  return (
    <div className="space-y-1.5">
      <div className="aspect-square w-full max-w-xs overflow-hidden rounded border border-gray-200 bg-surface-muted">
        {preview.kind === "html" ? (
          <iframe
            sandbox=""
            srcDoc={preview.html}
            title="Preview of one seed"
            className="h-full w-full border-0"
          />
        ) : (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={ipfsToHttp(preview.src)}
            alt="Preview of one seed"
            className="h-full w-full object-contain"
          />
        )}
      </div>
      <p className={HELP}>Preview of one seed</p>
    </div>
  )
}
