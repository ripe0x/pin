"use client"

/**
 * Entry point for the mint gate studio tool: pick a collection, then
 * manage its canonical minter's allowlist + per-wallet cap. The
 * "your collections" list comes from the indexed SurfaceCreated table
 * (owner-filtered SELECT, passed down by the server page — no chain
 * reads). The paste-an-address input stays beneath it for collections the
 * indexer doesn't have: a fork-mode dev deploy, a just-created collection
 * inside the indexing lag, or one owned via a post-deploy transfer (the
 * discovery table keys owner at create time).
 */

import { useState } from "react"
import { isAddress } from "viem"
import type { IndexedCollectionRow } from "@/lib/indexer-queries"
import { shortAddress } from "@/lib/collection"
import { BTN, ERROR, HELP, INPUT, LABEL } from "@/components/studio/create/wizard-ui"
import { MintGatePanel } from "./MintGatePanel"
import { V2Router } from "@/components/studio/v2/V2Router"
import { SurfaceV2MintGatePanel } from "@/components/studio/v2/SurfaceV2MintGatePanel"

export function MintGateTool({
  owned = [],
  initialCollection = null,
}: {
  owned?: IndexedCollectionRow[]
  /** Preselects a collection (`?collection=0x...`) instead of the picker. */
  initialCollection?: `0x${string}` | null
}) {
  const [input, setInput] = useState("")
  const [collection, setCollection] = useState<`0x${string}` | null>(initialCollection)

  const trimmed = input.trim()
  const valid = isAddress(trimmed)

  return (
    <div className="space-y-6">
      <header className="space-y-1.5">
        <h2 className="text-xl font-semibold tracking-tight">Mint gate</h2>
        <p className="text-sm text-gray-500 leading-relaxed">
          Gate a collection&apos;s mint with an allowlist: on a v1 collection
          directly on its canonical FixedPriceMinter clone (with a per-wallet
          limit), on a v2 collection through the AllowlistGate its sale
          points at. Only the collection&apos;s owner (or, on v1, an admin)
          can activate a gate on it.
        </p>
      </header>

      {!collection ? (
        <div className="space-y-5">
          {owned.length > 0 && (
            <div className="space-y-2">
              <p className={LABEL}>Your collections</p>
              <ul className="divide-y divide-gray-200 rounded-md border border-gray-200">
                {owned.map((c) => (
                  <li key={c.collection}>
                    <button
                      type="button"
                      onClick={() => setCollection(c.collection as `0x${string}`)}
                      className="flex w-full items-baseline justify-between gap-4 px-3 py-2.5 text-left hover:bg-gray-50 dark:hover:bg-gray-900"
                    >
                      <span className="truncate text-sm">
                        {c.name || shortAddress(c.collection)}
                        {c.symbol ? (
                          <span className="ml-2 text-[10px] font-mono uppercase tracking-wider text-gray-400">
                            {c.symbol}
                          </span>
                        ) : null}
                      </span>
                      <span className="shrink-0 text-[10px] font-mono text-gray-400">
                        {shortAddress(c.collection)}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
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
          <V2Router
            collection={collection}
            renderV1={() => <MintGatePanel collection={collection} />}
            renderV2={(state, refetch) => <SurfaceV2MintGatePanel state={state} refetch={refetch} />}
          />
        </div>
      )}
    </div>
  )
}
