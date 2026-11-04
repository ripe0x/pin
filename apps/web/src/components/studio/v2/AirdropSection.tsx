"use client"

/**
 * Airdrop / artist proofs for a primitive v2 collection, with no extra
 * contract (docs/pnd-surface-v2-design.md section 4): the owner takes the
 * single minter slot (setMinter(owner)), mints straight from the token
 * (mintTo, one call per recipient), and hands the slot back to the sale
 * (setMinter(sale)). One EIP-5792 wallet_sendCalls bundle where the wallet
 * supports it, otherwise one transaction per step, in order
 * (useBatchedCalls).
 *
 * While the owner holds the slot the public sale cannot mint. Owner mints
 * count toward the collection's supply cap, never toward the sale's
 * maxMints. If a sequential run stops half way, the owner still holds the
 * slot: the section then shows the restore step on its own (the sale
 * address is remembered in this browser, or entered).
 */

import { useEffect, useMemo, useState } from "react"
import { encodeFunctionData, isAddress, type Abi, type Address } from "viem"
import { useAccount, useConfig } from "wagmi"
import { simulateContract } from "wagmi/actions"
import { surfaceTokenV2Abi } from "@pin/abi"
import { PREFERRED_CHAIN, formatWriteError } from "@/components/tx/tx-ui"
import { StatusChip } from "@/components/auction/tx"
import { BTN, BTN_SECONDARY, ERROR, HELP, INPUT, LABEL, TEXTAREA } from "@/components/studio/create/wizard-ui"
import { shortAddress } from "@/lib/collection"
import { useBatchedCalls, type PreparedCall } from "@/lib/useBatchedCalls"
import { usePreflight } from "@/lib/use-preflight"
import {
  airdropProblems,
  airdropRestoreTarget,
  buildAirdropCalls,
  minterRole,
  parseAirdropRecipients,
  type AirdropCall,
  type SurfaceV2State,
} from "@/lib/surface-v2-studio"
import { Notice, Section } from "./ui"

const TOKEN_ABI = surfaceTokenV2Abi as Abi

function storageKey(collection: string) {
  return `pnd:v2-airdrop-restore:${collection.toLowerCase()}`
}
function readRemembered(collection: string): string | null {
  try {
    return window.localStorage.getItem(storageKey(collection))
  } catch {
    return null
  }
}
function remember(collection: string, sale: string) {
  try {
    window.localStorage.setItem(storageKey(collection), sale)
  } catch {
    // Storage unavailable: the restore step asks for the address instead.
  }
}

const CALL_LABEL: Record<AirdropCall["kind"], string> = {
  takeSlot: "Take the minter slot",
  mint: "Mint",
  restoreSlot: "Hand the slot back",
}

export function AirdropSection({
  state,
  enabled,
  onDone,
}: {
  state: SurfaceV2State
  enabled: boolean
  onDone: () => void
}) {
  const config = useConfig()
  const { address: account } = useAccount()
  const batch = useBatchedCalls({ chainId: PREFERRED_CHAIN.id })
  const preflight = usePreflight()
  const [raw, setRaw] = useState("")
  const [restoreInput, setRestoreInput] = useState("")
  const [remembered, setRemembered] = useState<string | null>(null)
  const [lastCalls, setLastCalls] = useState<AirdropCall[]>([])

  useEffect(() => {
    setRemembered(readRemembered(state.collection))
  }, [state.collection])

  const role = minterRole(state)
  const ownerHolds = role === "owner"
  const restoreTo = airdropRestoreTarget(state, restoreInput.trim() !== "" ? restoreInput : remembered)
  const parsed = useMemo(() => (raw.trim() === "" ? null : parseAirdropRecipients(raw)), [raw])
  const recipients = parsed?.ok ? parsed.recipients : []
  const problems = parsed?.ok ? airdropProblems(state, account, recipients) : []
  const running = batch.status === "running" || preflight.checking

  const calls = useMemo(
    () =>
      restoreTo
        ? buildAirdropCalls({ owner: state.owner, currentMinter: state.minter, restoreTo, recipients })
        : [],
    [restoreTo, state.owner, state.minter, recipients],
  )

  function prepared(list: AirdropCall[]): PreparedCall[] {
    return list.map((c, i) => ({
      id: c.id,
      to: state.collection,
      data: encodeFunctionData({ abi: TOKEN_ABI, functionName: c.functionName, args: c.args }),
      write: { address: state.collection, abi: TOKEN_ABI, functionName: c.functionName, args: c.args },
      // Every call after the first depends on the slot change before it,
      // so only the first can be checked against current chain state (it
      // is simulated below, and estimated again by the runner).
      skipPreflight: i > 0,
    }))
  }

  async function start(list: AirdropCall[]) {
    if (!account || list.length === 0 || !restoreTo) return
    remember(state.collection, restoreTo)
    setRemembered(restoreTo)
    setLastCalls(list)
    batch.reset()
    // Simulate the first call from the owner on PREFERRED_CHAIN before any
    // wallet prompt; the rest depend on it and run in order after.
    let ok = false
    await preflight.run(async () => {
      const first = list[0]
      await simulateContract(config, {
        account,
        chainId: PREFERRED_CHAIN.id,
        address: state.collection,
        abi: TOKEN_ABI,
        functionName: first.functionName,
        args: first.args,
      })
      ok = true
    })
    if (!ok) return
    await batch.run(prepared(list))
    onDone()
  }

  const canAirdrop =
    enabled && !!parsed?.ok && problems.length === 0 && !!restoreTo && calls.length > 0 && !running
  const restoreOnly: AirdropCall[] = restoreTo
    ? [{ id: "restore-slot", kind: "restoreSlot", functionName: "setMinter", args: [restoreTo] as const }]
    : []

  return (
    <Section
      title="Airdrop and artist proofs"
      help="Mint tokens straight to any wallets, free. The owner wallet takes the minter slot, mints, then hands the slot back to the sale, in one bundle where your wallet supports it or one transaction per step otherwise."
    >
      <Notice tone="amber">
        The public sale is paused while your wallet holds the minter slot. These mints count toward the
        collection&apos;s supply cap but not toward the sale&apos;s max mints.
      </Notice>

      {ownerHolds && (
        <div className="space-y-2 rounded border border-amber-200 p-3">
          <p className="text-xs text-amber-900">
            Your wallet holds the minter slot now, so the public sale cannot mint. Hand it back to the sale
            to reopen it.
          </p>
          <RestoreInput
            value={restoreInput}
            onChange={setRestoreInput}
            remembered={remembered}
            owner={state.owner}
          />
          <button
            type="button"
            disabled={!enabled || !restoreTo || running}
            onClick={() => void start(restoreOnly)}
            className={BTN_SECONDARY}
          >
            {running && lastCalls.length === 1 ? "Working…" : "Hand the slot back to the sale"}
          </button>
        </div>
      )}

      <label className="block">
        <span className={LABEL}>Recipients</span>
        <textarea
          value={raw}
          onChange={(e) => setRaw(e.target.value)}
          placeholder={"0xabc…\n0xdef…, 3"}
          rows={4}
          spellCheck={false}
          disabled={running}
          className={TEXTAREA}
        />
      </label>
      <p className={HELP}>One wallet per line. Add a comma and a number to send more than one token.</p>
      {parsed && !parsed.ok && <p className={ERROR}>{parsed.error}</p>}
      {parsed?.ok && (
        <p className="text-[11px] font-mono text-gray-500">
          {parsed.total.toString()} token{parsed.total === 1n ? "" : "s"} to {recipients.length} wallet
          {recipients.length === 1 ? "" : "s"}, then the slot goes back to{" "}
          {restoreTo ? shortAddress(restoreTo) : "the sale (enter its address above)"}.
        </p>
      )}
      {!ownerHolds && role === "none" && (
        <p className={HELP}>No minter is set now; after the airdrop the slot is cleared again.</p>
      )}
      {problems.map((p) => (
        <p key={p} className={ERROR}>
          {p}
        </p>
      ))}

      <button type="button" disabled={!canAirdrop} onClick={() => void start(calls)} className={BTN}>
        {preflight.checking
          ? "Checking…"
          : batch.status === "running"
            ? "Airdropping…"
            : `Airdrop${parsed?.ok ? ` ${parsed.total.toString()}` : ""}`}
      </button>
      <p className={HELP}>
        {batch.mode === "batched"
          ? "Your wallet supports batched calls: one signature for the whole airdrop."
          : batch.mode === "loading"
            ? "Checking whether your wallet can batch these calls…"
            : `One transaction per step (${calls.length || "3+"}), each confirmed before the next.`}
      </p>
      {preflight.error !== null && <p className={ERROR}>{formatWriteError(preflight.error, "Airdrop")}</p>}

      {lastCalls.length > 0 && batch.perItemStatus.size > 0 && (
        <ol className="divide-y divide-gray-100 rounded border border-gray-200 text-[11px] font-mono">
          {lastCalls.map((c) => (
            <li key={c.id} className="flex items-center justify-between gap-3 px-3 py-1.5">
              <span className="truncate">
                {CALL_LABEL[c.kind]}
                {c.kind === "mint" ? ` ${c.args[1].toString()} to ${shortAddress(c.args[0])}` : ""}
              </span>
              <StatusChip status={batch.perItemStatus.get(c.id)} />
            </li>
          ))}
        </ol>
      )}
    </Section>
  )
}

function RestoreInput({
  value,
  onChange,
  remembered,
  owner,
}: {
  value: string
  onChange: (v: string) => void
  remembered: string | null
  owner: Address
}) {
  const t = value.trim()
  const bad = t !== "" && (!isAddress(t) || t.toLowerCase() === owner.toLowerCase())
  return (
    <label className="block">
      <span className={LABEL}>Sale to hand the slot back to</span>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={remembered ?? "0x… sale address"}
        spellCheck={false}
        className={INPUT}
      />
      {bad && <span className={ERROR}>Enter the sale&apos;s address, not the owner wallet.</span>}
      {remembered && t === "" && (
        <span className={HELP}>Using the sale this browser remembered: {shortAddress(remembered)}.</span>
      )}
    </label>
  )
}
