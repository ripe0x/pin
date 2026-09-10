"use client"

/**
 * One collection's owner/admin settings: the levers that live on the
 * collection contract itself (as opposed to its minter — that's the Sale
 * tool). Current state is read once via the cached /settings API (no client
 * chain read); every change is a wallet tx written straight to the
 * collection's owner-only setters (surfaceAbi), authority enforced onchain.
 * One-way locks require typing the collection name to confirm.
 */

import { useCallback, useEffect, useState } from "react"
import { isAddress, type Address } from "viem"
import { useBytecode, useWaitForTransactionReceipt, useWriteContract } from "wagmi"
import { surfaceAbi, renderAssetsAbi } from "@pin/abi"
import { formatWriteError } from "@/components/tx/tx-ui"
import { BTN, BTN_SECONDARY, ERROR, HELP, INPUT, LABEL } from "@/components/studio/create/wizard-ui"
import { shortAddress } from "@/lib/collection"

const ZERO = "0x0000000000000000000000000000000000000000" as Address

type Settings = {
  name: string
  owner: Address
  renderer: Address
  isRendererLocked: boolean
  isSupplyLocked: boolean
  supplyCap: string
  minted: string
  royaltyBps: number
  royaltyReceiver: Address
  cover: string
  renderAssets: Address | null
  creators: { creator: Address; confirmed: boolean }[]
}

async function fetchSettings(collection: string): Promise<Settings | null> {
  try {
    const res = await fetch(`/api/collections/${collection.toLowerCase()}/settings`, {
      cache: "no-store",
    })
    if (!res.ok) return null
    return (await res.json()) as Settings
  } catch {
    return null
  }
}

/** A write bound to one target contract; refetches state on receipt. */
function useSetter(target: Address | null, abi: unknown, onConfirmed: () => void) {
  const write = useWriteContract()
  const receipt = useWaitForTransactionReceipt({ hash: write.data })
  useEffect(() => {
    if (receipt.isSuccess) onConfirmed()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [receipt.isSuccess])
  const busy = write.isPending || receipt.isLoading
  const label = write.isPending ? "Confirm in wallet…" : receipt.isLoading ? "Saving…" : null
  const run = (functionName: string, args: readonly unknown[]) => {
    if (!target) return
    write.writeContract({
      address: target,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      abi: abi as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      functionName: functionName as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      args: args as any,
    })
  }
  return { run, busy, label, error: write.error, reset: write.reset }
}

function Section({
  title,
  help,
  children,
}: {
  title: string
  help: string
  children: React.ReactNode
}) {
  return (
    <div className="rounded-lg border border-gray-200 p-4 space-y-3">
      <div className="space-y-0.5">
        <p className="text-sm font-medium">{title}</p>
        <p className="text-xs text-gray-500 leading-relaxed">{help}</p>
      </div>
      {children}
    </div>
  )
}

export function CollectionSettingsPanel({ collection }: { collection: `0x${string}` }) {
  const [s, setS] = useState<Settings | null | undefined>(undefined)
  const refetch = useCallback(() => {
    setS(undefined)
    void fetchSettings(collection).then(setS)
  }, [collection])
  useEffect(() => {
    refetch()
  }, [refetch])

  if (s === undefined) return <p className="text-sm text-gray-500">Loading settings…</p>
  if (s === null) return <p className={ERROR}>Could not load this collection.</p>

  return (
    <div className="space-y-4">
      <RendererSection collection={collection} s={s} onDone={refetch} />
      <LocksSection collection={collection} s={s} onDone={refetch} />
      <SupplySection collection={collection} s={s} onDone={refetch} />
      <RoyaltySection collection={collection} s={s} onDone={refetch} />
      <CoverSection collection={collection} s={s} onDone={refetch} />
      <MintersSection collection={collection} onDone={refetch} />
      <CreatorsSection collection={collection} s={s} onDone={refetch} />
    </div>
  )
}

function RendererSection({
  collection,
  s,
  onDone,
}: {
  collection: Address
  s: Settings
  onDone: () => void
}) {
  const [next, setNext] = useState("")
  const setter = useSetter(collection, surfaceAbi, onDone)
  const trimmed = next.trim()
  const valid = isAddress(trimmed)
  // A non-contract renderer bricks tokenURI: soft-check the pasted address has
  // code before enabling submit (mirrors SeededDeployWizard).
  const { data: code } = useBytecode({
    address: valid ? (trimmed as Address) : undefined,
    query: { enabled: valid },
  })
  const isContract = !!code && code !== "0x"

  return (
    <Section
      title="Renderer"
      help="The contract that answers tokenURI. Swapping it changes how every token renders."
    >
      <p className="text-[11px] font-mono text-gray-500 break-all">
        Current: {s.renderer}
      </p>
      {s.isRendererLocked ? (
        <p className={ERROR}>
          The renderer is locked. This collection renders through the current
          contract permanently and cannot be changed.
        </p>
      ) : (
        <div className="space-y-2">
          <input
            type="text"
            value={next}
            onChange={(e) => setNext(e.target.value)}
            placeholder="0x… new renderer"
            spellCheck={false}
            className={INPUT}
          />
          {valid && !isContract && (
            <p className={ERROR}>No contract code at this address. A non-contract renderer bricks tokenURI.</p>
          )}
          <button
            type="button"
            disabled={!valid || !isContract || setter.busy}
            onClick={() => setter.run("setRenderer", [trimmed as Address])}
            className={BTN}
          >
            {setter.label ?? "Set renderer"}
          </button>
          {setter.error && <p className={ERROR}>{formatWriteError(setter.error, "set renderer")}</p>}
        </div>
      )}
    </Section>
  )
}

/** A one-way lock with type-to-confirm on the collection name. */
function LockButton({
  collection,
  name,
  locked,
  fn,
  actionLabel,
  onDone,
}: {
  collection: Address
  name: string
  locked: boolean
  fn: "lockRenderer" | "lockSupply"
  actionLabel: string
  onDone: () => void
}) {
  const [confirm, setConfirm] = useState("")
  const setter = useSetter(collection, surfaceAbi, onDone)
  const matches = confirm.trim() === name

  if (locked) {
    return <p className="text-xs text-gray-500">Locked permanently.</p>
  }
  return (
    <div className="space-y-2">
      <p className="text-xs text-gray-500 leading-relaxed">
        This is permanent and cannot be undone. Type the collection name
        <span className="font-mono"> {name} </span>
        to confirm.
      </p>
      <input
        type="text"
        value={confirm}
        onChange={(e) => setConfirm(e.target.value)}
        placeholder={name}
        spellCheck={false}
        className={INPUT}
      />
      <button
        type="button"
        disabled={!matches || setter.busy}
        onClick={() => setter.run(fn, [])}
        className={BTN}
      >
        {setter.label ?? actionLabel}
      </button>
      {setter.error && <p className={ERROR}>{formatWriteError(setter.error, actionLabel)}</p>}
    </div>
  )
}

function LocksSection({
  collection,
  s,
  onDone,
}: {
  collection: Address
  s: Settings
  onDone: () => void
}) {
  return (
    <Section
      title="Permanence locks"
      help="One-way promises. Locking the renderer pins how tokens render forever; locking supply fixes the cap forever."
    >
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <p className={LABEL}>Renderer</p>
          <LockButton
            collection={collection}
            name={s.name}
            locked={s.isRendererLocked}
            fn="lockRenderer"
            actionLabel="Lock renderer forever"
            onDone={onDone}
          />
        </div>
        <div className="space-y-1.5">
          <p className={LABEL}>Supply</p>
          <LockButton
            collection={collection}
            name={s.name}
            locked={s.isSupplyLocked}
            fn="lockSupply"
            actionLabel="Lock supply forever"
            onDone={onDone}
          />
        </div>
      </div>
    </Section>
  )
}

function SupplySection({
  collection,
  s,
  onDone,
}: {
  collection: Address
  s: Settings
  onDone: () => void
}) {
  const [cap, setCap] = useState("")
  const setter = useSetter(collection, surfaceAbi, onDone)
  const current = s.supplyCap === "0" ? "Open (no cap)" : s.supplyCap
  const parsed = cap.trim() === "" ? null : (() => { try { return BigInt(cap.trim()) } catch { return null } })()
  const valid = parsed !== null && parsed >= BigInt(s.minted)

  return (
    <Section
      title="Supply cap"
      help="The maximum tokens this collection can ever mint. 0 means open. Cannot be set below what is already minted."
    >
      <p className="text-[11px] font-mono text-gray-500">
        Current: {current} · {s.minted} minted
      </p>
      {s.isSupplyLocked ? (
        <p className="text-xs text-gray-500">Supply is locked; the cap is permanent.</p>
      ) : (
        <div className="space-y-2">
          <input
            type="text"
            inputMode="numeric"
            value={cap}
            onChange={(e) => setCap(e.target.value.replace(/[^0-9]/g, ""))}
            placeholder="new cap (0 = open)"
            className={INPUT}
          />
          {parsed !== null && parsed !== 0n && parsed < BigInt(s.minted) && (
            <p className={ERROR}>Cap cannot be below the {s.minted} already minted.</p>
          )}
          <button
            type="button"
            disabled={!valid || setter.busy}
            onClick={() => parsed !== null && setter.run("setSupplyCap", [parsed])}
            className={BTN}
          >
            {setter.label ?? "Set supply cap"}
          </button>
          {setter.error && <p className={ERROR}>{formatWriteError(setter.error, "set supply cap")}</p>}
        </div>
      )}
    </Section>
  )
}

function RoyaltySection({
  collection,
  s,
  onDone,
}: {
  collection: Address
  s: Settings
  onDone: () => void
}) {
  const [bps, setBps] = useState(String(s.royaltyBps))
  const [receiver, setReceiver] = useState(s.royaltyReceiver === ZERO ? "" : s.royaltyReceiver)
  const setter = useSetter(collection, surfaceAbi, onDone)
  const bpsNum = Number(bps || "0")
  const receiverAddr = receiver.trim() === "" ? s.owner : receiver.trim()
  const valid = bpsNum >= 0 && bpsNum <= 10_000 && isAddress(receiverAddr)

  return (
    <Section
      title="Royalty"
      help="The EIP-2981 secondary royalty: basis points (100 = 1%) and the receiver. Empty receiver defaults to the collection owner."
    >
      <p className="text-[11px] font-mono text-gray-500">
        Current: {s.royaltyBps / 100}% to{" "}
        {s.royaltyReceiver === ZERO ? "owner (default)" : shortAddress(s.royaltyReceiver)}
      </p>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <label className="block">
          <span className={LABEL}>Basis points</span>
          <input
            type="text"
            inputMode="numeric"
            value={bps}
            onChange={(e) => setBps(e.target.value.replace(/[^0-9]/g, ""))}
            className={INPUT}
          />
        </label>
        <label className="block">
          <span className={LABEL}>Receiver</span>
          <input
            type="text"
            value={receiver}
            onChange={(e) => setReceiver(e.target.value)}
            placeholder="0x… (default: owner)"
            spellCheck={false}
            className={INPUT}
          />
        </label>
      </div>
      {bpsNum > 10_000 && <p className={ERROR}>Basis points cannot exceed 10000 (100%).</p>}
      <button
        type="button"
        disabled={!valid || setter.busy}
        onClick={() => setter.run("setRoyalty", [bpsNum, receiverAddr as Address])}
        className={BTN}
      >
        {setter.label ?? "Set royalty"}
      </button>
      {setter.error && <p className={ERROR}>{formatWriteError(setter.error, "set royalty")}</p>}
    </Section>
  )
}

function CoverSection({
  collection,
  s,
  onDone,
}: {
  collection: Address
  s: Settings
  onDone: () => void
}) {
  const [uri, setUri] = useState(s.cover)
  const setter = useSetter(s.renderAssets, renderAssetsAbi, onDone)
  const changed = uri.trim() !== s.cover && uri.trim().length > 0

  return (
    <Section
      title="Cover"
      help="The collection cover image (its marketplace poster and the fallback token thumbnail), stored in the RenderAssets registry."
    >
      {!s.renderAssets ? (
        <p className="text-xs text-gray-500">
          The RenderAssets registry is not deployed on this network yet. The
          cover cannot be set here.
        </p>
      ) : (
        <div className="space-y-2">
          <p className="text-[11px] font-mono text-gray-500 break-all">
            Current: {s.cover || "none"}
          </p>
          <input
            type="text"
            value={uri}
            onChange={(e) => setUri(e.target.value)}
            placeholder="ipfs://… or data:image/…"
            spellCheck={false}
            className={INPUT}
          />
          <button
            type="button"
            disabled={!changed || setter.busy}
            onClick={() => setter.run("setCover", [collection, uri.trim()])}
            className={BTN}
          >
            {setter.label ?? "Set cover"}
          </button>
          {setter.error && <p className={ERROR}>{formatWriteError(setter.error, "set cover")}</p>}
        </div>
      )}
    </Section>
  )
}

function MintersSection({ collection, onDone }: { collection: Address; onDone: () => void }) {
  const [addr, setAddr] = useState("")
  const setter = useSetter(collection, surfaceAbi, onDone)
  const trimmed = addr.trim()
  const valid = isAddress(trimmed)
  const { data: code } = useBytecode({
    address: valid ? (trimmed as Address) : undefined,
    query: { enabled: valid },
  })
  const isContract = !!code && code !== "0x"

  return (
    <Section
      title="Extension minters"
      help="Grant or revoke a minter contract's right to mint. The collection has no enumeration getter, so minters are managed by address, not listed."
    >
      <input
        type="text"
        value={addr}
        onChange={(e) => setAddr(e.target.value)}
        placeholder="0x… minter contract"
        spellCheck={false}
        className={INPUT}
      />
      {valid && !isContract && (
        <p className={ERROR}>No contract code at this address.</p>
      )}
      <div className="flex gap-2">
        <button
          type="button"
          disabled={!valid || !isContract || setter.busy}
          onClick={() => setter.run("setMinter", [trimmed as Address, true])}
          className={BTN}
        >
          {setter.label ?? "Grant"}
        </button>
        <button
          type="button"
          disabled={!valid || setter.busy}
          onClick={() => setter.run("setMinter", [trimmed as Address, false])}
          className={BTN_SECONDARY}
        >
          Revoke
        </button>
      </div>
      {setter.error && <p className={ERROR}>{formatWriteError(setter.error, "set minter")}</p>}
    </Section>
  )
}

function CreatorsSection({
  collection,
  s,
  onDone,
}: {
  collection: Address
  s: Settings
  onDone: () => void
}) {
  const [addr, setAddr] = useState("")
  const setter = useSetter(collection, surfaceAbi, onDone)
  const trimmed = addr.trim()
  const valid = isAddress(trimmed)

  return (
    <Section
      title="Attribution roster"
      help="The creators you list for this collection. A listed creator is confirmed once they claim the contract in the Catalog; the claim is their own action."
    >
      {s.creators.length > 0 ? (
        <ul className="divide-y divide-gray-200 rounded border border-gray-200">
          {s.creators.map((c) => (
            <li key={c.creator} className="flex items-center justify-between gap-3 px-3 py-2">
              <span className="text-[11px] font-mono break-all">{c.creator}</span>
              <div className="flex items-center gap-3 shrink-0">
                <span className="text-[10px] font-mono uppercase tracking-wider text-gray-400">
                  {c.confirmed ? "Confirmed" : "Listed"}
                </span>
                <button
                  type="button"
                  disabled={setter.busy}
                  onClick={() => setter.run("setCreators", [[c.creator], false])}
                  className="text-[10px] font-mono uppercase tracking-wider text-gray-400 underline hover:text-fg"
                >
                  Remove
                </button>
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-xs text-gray-500">No creators listed yet.</p>
      )}
      <div className="space-y-2">
        <input
          type="text"
          value={addr}
          onChange={(e) => setAddr(e.target.value)}
          placeholder="0x… creator address"
          spellCheck={false}
          className={INPUT}
        />
        <button
          type="button"
          disabled={!valid || setter.busy}
          onClick={() => setter.run("setCreators", [[trimmed as Address], true])}
          className={BTN}
        >
          {setter.label ?? "List creator"}
        </button>
        {setter.error && <p className={ERROR}>{formatWriteError(setter.error, "set creators")}</p>}
      </div>
    </Section>
  )
}
