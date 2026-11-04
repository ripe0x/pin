"use client"

/**
 * Mint gate for a primitive v2 collection: an allowlist through PND's
 * AllowlistGate singleton (one Merkle root per collection, set by the
 * collection's owner), wired into the sale with setGate. Publishing the list
 * stores it for the proof route (GET /api/collections/[address]/allowlist
 * ?wallet=, keyed by collection, which serves proofs only for the root
 * that is active onchain); activating sets the root and points the sale at
 * the gate, batched where the wallet supports it. The per-wallet cap is a
 * sale setting (Sale settings).
 */

import { useState } from "react"
import { encodeFunctionData, type Abi, type Address } from "viem"
import { useAccount, useConfig } from "wagmi"
import { simulateContract } from "wagmi/actions"
import { allowlistGateAbi, fixedPriceSaleAbi } from "@pin/abi"
import { PREFERRED_CHAIN, formatWriteError } from "@/components/tx/tx-ui"
import { StatusChip } from "@/components/auction/tx"
import { BTN, BTN_SECONDARY, ERROR, HELP } from "@/components/studio/create/wizard-ui"
import { shortAddress } from "@/lib/collection"
import { useBatchedCalls, type PreparedCall } from "@/lib/useBatchedCalls"
import { usePreflight } from "@/lib/use-preflight"
import {
  ZERO_ADDRESS,
  ZERO_ROOT,
  gateActivationCalls,
  gateStatus,
  isOwner,
  minterRole,
  type GateActivationCall,
  type SurfaceV2State,
} from "@/lib/surface-v2-studio"
import { AllowlistEditor } from "@/components/studio/mint-gate/AllowlistEditor"
import { useV2Write } from "./useV2Write"
import { Notice, ReadGrid, Section, WriteError } from "./ui"

const GATE_ABI = allowlistGateAbi as Abi
const SALE_ABI = fixedPriceSaleAbi as Abi

const STATUS_COPY = {
  none: "Not gated: anyone can mint",
  allowlist: "Allowlist (AllowlistGate)",
  "allowlist-unset": "AllowlistGate with no root: every mint fails",
  other: "A custom gate PND does not manage",
} as const

function shortRoot(root: string) {
  return root === ZERO_ROOT ? "None" : `${root.slice(0, 10)}…${root.slice(-6)}`
}

export function SurfaceV2MintGatePanel({ state, refetch }: { state: SurfaceV2State; refetch: () => void }) {
  const config = useConfig()
  const { address: account } = useAccount()
  const batch = useBatchedCalls({ chainId: PREFERRED_CHAIN.id })
  const preflight = usePreflight()
  const clear = useV2Write(refetch)
  const [publishedRoot, setPublishedRoot] = useState<`0x${string}` | null>(null)
  const [lastCalls, setLastCalls] = useState<GateActivationCall[]>([])

  const sale = state.sale
  if (!sale) {
    return (
      <Notice tone="amber">
        {minterRole(state) === "owner"
          ? "Your wallet holds the collection's minter slot (an airdrop that has not handed it back). Hand it back to the sale under Collection settings before gating the sale."
          : "This collection's minter is not a PND fixed-price sale, so there is no sale to gate here."}
      </Notice>
    )
  }
  const gate = state.allowlistGate
  const status = gateStatus(state)
  const owner = isOwner(state, account)
  const enabled = owner && !sale.closed
  const running = batch.status === "running" || preflight.checking

  const calls =
    gate && publishedRoot
      ? gateActivationCalls({
          collection: state.collection,
          allowlistGate: gate,
          sale: sale.address,
          currentGate: sale.gate,
          root: publishedRoot,
        })
      : []
  const alreadyActive = !!publishedRoot && status === "allowlist" && publishedRoot.toLowerCase() === state.gateRoot.toLowerCase()

  function prepared(list: GateActivationCall[]): PreparedCall[] {
    return list.map((c) => {
      const abi = c.target === "gate" ? GATE_ABI : SALE_ABI
      return {
        id: c.id,
        to: c.to,
        data: encodeFunctionData({ abi, functionName: c.functionName, args: c.args }),
        write: { address: c.to, abi, functionName: c.functionName, args: c.args },
      }
    })
  }

  async function activate() {
    if (!account || calls.length === 0) return
    setLastCalls(calls)
    batch.reset()
    // Both calls stand alone (setGate does not depend on the root), so
    // both are simulated from the owner before any wallet prompt.
    let ok = false
    await preflight.run(async () => {
      for (const c of calls) {
        await simulateContract(config, {
          account,
          chainId: PREFERRED_CHAIN.id,
          address: c.to,
          abi: c.target === "gate" ? GATE_ABI : SALE_ABI,
          functionName: c.functionName,
          args: c.args,
        })
      }
      ok = true
    })
    if (!ok) return
    await batch.run(prepared(calls))
    refetch()
  }

  return (
    <div className="space-y-6">
      <ReadGrid
        title="Current gate state"
        rows={[
          ["Sale", shortAddress(sale.address)],
          ["Gate", STATUS_COPY[status]],
          ["Active root", shortRoot(state.gateRoot)],
          ["Published list", state.gateListCount === null ? "None for this root" : `${state.gateListCount} addresses`],
          ["Per-wallet cap", sale.walletCap === "0" ? "No limit" : sale.walletCap],
        ]}
      />
      {!gate && (
        <Notice tone="amber">The AllowlistGate is not configured on this network, so allowlists cannot be set here yet.</Notice>
      )}
      {sale.closed && <Notice>This sale is closed, so its gate no longer matters.</Notice>}
      {!state.renounced && !owner && (
        <Notice tone="amber">Connect the collection owner&apos;s wallet to change the gate.</Notice>
      )}

      {gate && !sale.closed && !state.renounced && (
        <>
          <AllowlistEditor collection={state.collection} onPublished={(root) => setPublishedRoot(root)} />

          <Section
            title="Activate the allowlist"
            help="Sets the published list's root on the AllowlistGate and points the sale at the gate. Until both land, nothing changes for minters. Only wallets on the list can mint while the gate is set."
          >
            {!publishedRoot && <p className={HELP}>Publish a list above first.</p>}
            {publishedRoot && (
              <p className="text-[11px] font-mono text-gray-500">
                Root {shortRoot(publishedRoot)}:{" "}
                {calls.map((c) => (c.functionName === "setRoot" ? "set the root" : "gate the sale")).join(", then ")}.
              </p>
            )}
            <button
              type="button"
              disabled={!enabled || !publishedRoot || calls.length === 0 || alreadyActive || running}
              onClick={() => void activate()}
              className={BTN}
            >
              {preflight.checking ? "Checking…" : batch.status === "running" ? "Activating…" : alreadyActive ? "Active" : "Activate allowlist"}
            </button>
            <p className={HELP}>
              {batch.mode === "batched"
                ? "Your wallet supports batched calls: one signature for both."
                : "One transaction per step, in order."}
            </p>
            {preflight.error !== null && <p className={ERROR}>{formatWriteError(preflight.error, "Activate")}</p>}
            {lastCalls.length > 0 && batch.perItemStatus.size > 0 && (
              <ol className="divide-y divide-gray-100 rounded border border-gray-200 text-[11px] font-mono">
                {lastCalls.map((c) => (
                  <li key={c.id} className="flex items-center justify-between gap-3 px-3 py-1.5">
                    <span>{c.functionName === "setRoot" ? "Set the root on the AllowlistGate" : "Point the sale at the gate"}</span>
                    <StatusChip status={batch.perItemStatus.get(c.id)} />
                  </li>
                ))}
              </ol>
            )}
          </Section>

          {status !== "none" && (
            <Section title="Remove the gate" help="Points the sale at no gate: anyone can mint again. The root stays on the AllowlistGate, so the list can be switched back on later.">
              <button
                type="button"
                disabled={!enabled || clear.busy}
                onClick={() =>
                  clear.run({ address: sale.address, abi: SALE_ABI, functionName: "setGate", args: [ZERO_ADDRESS as Address] })
                }
                className={BTN_SECONDARY}
              >
                {clear.label ?? "Remove gate"}
              </button>
              <WriteError error={clear.error} action="Remove gate" />
            </Section>
          )}
        </>
      )}

      <p className="text-[10px] font-mono text-gray-400 leading-relaxed border-t border-gray-100 pt-4">
        Publishing a list only stores it. The mint page serves proofs, by collection, only for the root that
        is active on the AllowlistGate right now, so an old list stays inert unless you activate it again.
      </p>
    </div>
  )
}
