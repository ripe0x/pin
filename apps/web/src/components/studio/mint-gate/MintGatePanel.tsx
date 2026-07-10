"use client"

/**
 * One collection's mint gate: current state (read-only, via the cached
 * allowlist API) + the allowlist editor + the onchain activation queue.
 * No client-side chain reads live here — only the write transactions in
 * ActivationQueue and their receipts.
 */

import { useCallback, useEffect, useState } from "react"
import { shortAddress } from "@/lib/collection"
import { AllowlistEditor } from "./AllowlistEditor"
import { ActivationQueue } from "./ActivationQueue"
import { deriveGate, fetchGateState, ZERO_ROOT, type DerivedGate, type GateApiState } from "./gate-api"

function GateStatusCard({ loading, derived }: { loading: boolean; derived: DerivedGate | null }) {
  if (loading) {
    return <p className="text-[11px] font-mono text-gray-400">Reading current gate state…</p>
  }
  if (!derived) {
    return (
      <p className="text-[11px] font-mono text-gray-400">
        Could not read this collection&apos;s gate state. Check the address and try again.
      </p>
    )
  }
  return (
    <div className="rounded border border-gray-200 bg-surface-muted/40 px-3 py-2.5 space-y-1.5">
      <p className="text-[10px] font-mono uppercase tracking-wider text-gray-400">Current gate state</p>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-[11px] font-mono text-gray-600">
        <dt className="text-gray-400">Hook</dt>
        <dd>
          {derived.hookAttached
            ? "GateHook attached"
            : derived.otherHookAddress
              ? `Other hook (${shortAddress(derived.otherHookAddress)})`
              : "Not attached"}
        </dd>
        <dt className="text-gray-400">Active root</dt>
        <dd>{derived.root === ZERO_ROOT ? "None" : `${derived.root.slice(0, 10)}…${derived.root.slice(-6)}`}</dd>
        <dt className="text-gray-400">Per-wallet cap</dt>
        <dd>{derived.cap === "0" ? "No limit" : derived.cap}</dd>
        <dt className="text-gray-400">Published list</dt>
        <dd>{derived.count === null ? "—" : `${derived.count} address${derived.count === 1 ? "" : "es"}`}</dd>
      </dl>
    </div>
  )
}

export function MintGatePanel({ collection }: { collection: `0x${string}` }) {
  const [state, setState] = useState<GateApiState | null | undefined>(undefined)
  const [publishedRoot, setPublishedRoot] = useState<`0x${string}` | null>(null)

  const refetch = useCallback(() => {
    setState(undefined)
    void fetchGateState(collection).then(setState)
  }, [collection])

  useEffect(() => {
    refetch()
  }, [refetch])

  const loading = state === undefined
  const derived = loading ? null : deriveGate(state)

  return (
    <div className="space-y-6">
      <GateStatusCard loading={loading} derived={derived} />

      <AllowlistEditor collection={collection} onPublished={(root) => setPublishedRoot(root)} />

      <ActivationQueue
        collection={collection}
        derived={derived}
        publishedRoot={publishedRoot}
        onConfirmed={refetch}
      />

      <p className="text-[10px] font-mono text-gray-400 leading-relaxed border-t border-gray-100 pt-4">
        Publishing a list only stores it — nothing is granted until you set
        it as the active root onchain. The mint page only ever serves
        proofs for the root that is active right now, so an old published
        list stays inert unless you reactivate it. The state above is
        cached for a short window and can take up to twenty seconds to
        reflect a transaction you just confirmed.
      </p>
    </div>
  )
}
