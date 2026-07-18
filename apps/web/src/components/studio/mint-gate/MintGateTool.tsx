"use client"

/**
 * Entry point for the mint gate studio tool: pick a collection, then
 * manage its GateHook allowlist + per-wallet cap. There is no existing
 * "collections owned by this address" read (the factory only lists
 * newest-first, not by owner — see getRecentCollections in
 * collection-onchain.ts), so this accepts a pasted collection address
 * rather than inventing a new chain-scanning read.
 */

import { useState } from "react"
import { isAddress } from "viem"
import { BTN, ERROR, HELP, INPUT, LABEL } from "@/components/studio/create/wizard-ui"
import { MintGatePanel } from "./MintGatePanel"

export function MintGateTool() {
  const [input, setInput] = useState("")
  const [collection, setCollection] = useState<`0x${string}` | null>(null)

  const trimmed = input.trim()
  const valid = isAddress(trimmed)

  return (
    <div className="space-y-6">
      <header className="space-y-1.5">
        <h2 className="text-xl font-semibold tracking-tight">Mint gate</h2>
        <p className="text-sm text-gray-500 leading-relaxed">
          Gate a collection&apos;s mint with an allowlist and a per-wallet
          limit, enforced by GateHook, a shared, public-good hook
          contract. Only the collection&apos;s own owner or an admin can
          activate a gate on it.
        </p>
      </header>

      {!collection ? (
        <div className="space-y-2">
          <label className="block">
            <span className={LABEL}>Collection address</span>
            <input
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="0x…"
              spellCheck={false}
              className={INPUT}
            />
          </label>
          {trimmed.length > 0 && !valid && <p className={ERROR}>Not a valid address.</p>}
          <p className={HELP}>
            Paste the address of a Surface you own or
            administer (from Create a collection, or any other you
            deployed).
          </p>
          <button
            type="button"
            onClick={() => valid && setCollection(trimmed as `0x${string}`)}
            disabled={!valid}
            className={BTN}
          >
            Load collection
          </button>
        </div>
      ) : (
        <div className="space-y-4">
          <div className="flex items-center justify-between gap-4">
            <p className="text-[11px] font-mono text-gray-500 break-all">{collection}</p>
            <div className="flex items-center gap-3 shrink-0">
              <a
                href={`/collections/${collection}`}
                target="_blank"
                rel="noopener noreferrer"
                className="text-[10px] font-mono uppercase tracking-wider text-gray-400 hover:text-fg underline"
              >
                View mint page ↗
              </a>
              <button
                type="button"
                onClick={() => setCollection(null)}
                className="text-[10px] font-mono uppercase tracking-wider text-gray-400 hover:text-fg underline"
              >
                Change collection
              </button>
            </div>
          </div>
          <MintGatePanel collection={collection} />
        </div>
      )}
    </div>
  )
}
