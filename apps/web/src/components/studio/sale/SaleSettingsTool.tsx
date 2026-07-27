"use client"

/**
 * Entry point for the Sale Settings studio tool: pick a collection, then edit
 * its canonical minter's price, mint window, max mints, payout, and referral
 * share. The "your collections" list is the indexed SurfaceCreated table
 * (owner-filtered SELECT, from the server page). The paste-an-address input
 * carries collections the indexer doesn't have (fork/sepolia, indexing lag,
 * post-deploy transfer).
 */

import { useState } from "react"
import { isAddress } from "viem"
import type { IndexedCollectionRow } from "@/lib/indexer-queries"
import { shortAddress } from "@/lib/collection"
import { BTN, ERROR, HELP, INPUT, LABEL } from "@/components/studio/create/wizard-ui"
import { SaleSettingsPanel } from "./SaleSettingsPanel"

export function SaleSettingsTool({ owned = [] }: { owned?: IndexedCollectionRow[] }) {
  const [input, setInput] = useState("")
  const [collection, setCollection] = useState<`0x${string}` | null>(null)

  const trimmed = input.trim()
  const valid = isAddress(trimmed)

  return (
    <div className="space-y-6">
      <header className="space-y-1.5">
        <h2 className="text-xl font-semibold tracking-tight">Sale settings</h2>
        <p className="text-sm text-gray-500 leading-relaxed">
          Edit a collection&apos;s price, mint window, max mints, payout, and
          referral share, directly on its canonical minter. Only the
          collection&apos;s owner or an admin can change them.
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
            <p className={HELP}>Paste the address of a Surface you own or administer.</p>
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
          <SaleSettingsPanel collection={collection} />
        </div>
      )}
    </div>
  )
}
