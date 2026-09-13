"use client"

/**
 * One collection's authority management: owner, live admin set, and the
 * renderer lock. Reads come from the cached /admins API (no client-side
 * chain read; see collection-onchain.ts's getCollectionAuthority for the
 * admin-log scan this wraps). Every write here, addAdmin, removeAdmin,
 * lockRenderer, is a wallet transaction sent directly to the collection;
 * onchain authority (owner-only, or owner-or-self, or owner-or-admin)
 * enforces who can actually confirm it.
 */

import { useCallback, useEffect, useState } from "react"
import { isAddress, type Address } from "viem"
import { useAccount, useChainId, useWaitForTransactionReceipt, useWriteContract } from "wagmi"
import { surfaceAbi } from "@pin/abi"
import { evmNowTxUrl, formatWriteError } from "@/components/tx/tx-ui"
import { shortAddress } from "@/lib/collection"
import { BTN_SECONDARY, ERROR, INPUT } from "@/components/studio/create/wizard-ui"
import { fetchAuthorityState, type AuthorityState } from "./admins-api"

type Role = "owner" | "admin" | "none"

function roleOf(state: AuthorityState | null, connected: Address | undefined): Role {
  if (!state || !connected) return "none"
  const c = connected.toLowerCase()
  if (state.owner.toLowerCase() === c) return "owner"
  if (state.admins.some((a) => a.toLowerCase() === c)) return "admin"
  return "none"
}

function TxLink({ hash, chainId }: { hash: `0x${string}`; chainId: number }) {
  return (
    <a
      href={evmNowTxUrl(hash, chainId)}
      target="_blank"
      rel="noopener noreferrer"
      className="text-[10px] font-mono text-status-available underline"
    >
      Confirmed: {hash.slice(0, 10)}…{hash.slice(-8)} ↗
    </a>
  )
}

function RoleCard({ loading, state, role }: { loading: boolean; state: AuthorityState | null; role: Role }) {
  if (loading) {
    return <p className="text-[11px] font-mono text-gray-400">Reading current authority…</p>
  }
  if (!state) {
    return (
      <p className={ERROR}>Could not read this collection&apos;s authority. Check the address and try again.</p>
    )
  }
  const roleLabel = role === "owner" ? "Owner" : role === "admin" ? "Admin" : "Not connected as owner or admin"
  return (
    <div className="rounded border border-gray-200 bg-surface-muted/40 px-3 py-2.5 space-y-1.5">
      <p className="text-[10px] font-mono uppercase tracking-wider text-gray-400">Authority</p>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-[11px] font-mono text-gray-600">
        <dt className="text-gray-400">Owner</dt>
        <dd className="break-all">{shortAddress(state.owner)}</dd>
        <dt className="text-gray-400">You</dt>
        <dd>{roleLabel}</dd>
        <dt className="text-gray-400">Admins</dt>
        <dd>{state.admins.length}</dd>
      </dl>
    </div>
  )
}

function AddAdminForm({
  collection,
  onConfirmed,
}: {
  collection: Address
  onConfirmed: () => void
}) {
  const chainId = useChainId()
  const [input, setInput] = useState("")
  const write = useWriteContract()
  const receipt = useWaitForTransactionReceipt({ hash: write.data })
  useEffect(() => {
    if (receipt.isSuccess) {
      setInput("")
      onConfirmed()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [receipt.isSuccess])

  const trimmed = input.trim()
  const valid = isAddress(trimmed)
  const busy = write.isPending || receipt.isLoading

  return (
    <div className="rounded border border-gray-200 p-3 space-y-2">
      <p className="text-sm font-medium">Add an admin</p>
      <p className="text-xs text-gray-500 leading-relaxed">
        An admin can use every management function on this collection that
        you can, except managing admins and transferring ownership.
        Owner-only.
      </p>
      <div className="flex items-stretch gap-2">
        <input
          value={input}
          onChange={(e) => setInput(e.target.value.trim())}
          placeholder="0x…"
          spellCheck={false}
          disabled={busy}
          className={`${INPUT} flex-1`}
        />
        <button
          type="button"
          disabled={!valid || busy}
          onClick={() =>
            write.writeContract({
              address: collection,
              abi: surfaceAbi,
              functionName: "addAdmin",
              args: [trimmed as Address],
            })
          }
          className={BTN_SECONDARY}
        >
          {write.isPending ? "Confirm in wallet…" : receipt.isLoading ? "Adding…" : "Add"}
        </button>
      </div>
      {input.trim() !== "" && !valid && <p className={ERROR}>Not a valid address.</p>}
      {write.error && <p className={ERROR}>{formatWriteError(write.error, "Add admin")}</p>}
      {receipt.isSuccess && write.data && <TxLink hash={write.data} chainId={chainId} />}
    </div>
  )
}

function AdminRow({
  collection,
  admin,
  canRemove,
  onConfirmed,
}: {
  collection: Address
  admin: Address
  canRemove: boolean
  onConfirmed: () => void
}) {
  const chainId = useChainId()
  const [armed, setArmed] = useState(false)
  const write = useWriteContract()
  const receipt = useWaitForTransactionReceipt({ hash: write.data })
  useEffect(() => {
    if (receipt.isSuccess) {
      setArmed(false)
      onConfirmed()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [receipt.isSuccess])
  useEffect(() => {
    if (!armed) return
    const t = setTimeout(() => setArmed(false), 6000)
    return () => clearTimeout(t)
  }, [armed])

  const busy = write.isPending || receipt.isLoading

  return (
    <li className="px-3 py-2.5 space-y-1.5">
      <div className="flex items-center justify-between gap-4">
        <span className="text-[11px] font-mono break-all">{admin}</span>
        {canRemove && (
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              if (!armed) {
                setArmed(true)
                return
              }
              write.writeContract({
                address: collection,
                abi: surfaceAbi,
                functionName: "removeAdmin",
                args: [admin],
              })
            }}
            className="shrink-0 text-[10px] font-mono uppercase tracking-wider text-gray-400 hover:text-red-500 disabled:opacity-40"
          >
            {write.isPending ? "Confirm in wallet…" : receipt.isLoading ? "Removing…" : armed ? "Click again to remove" : "Remove"}
          </button>
        )}
      </div>
      {write.error && <p className={ERROR}>{formatWriteError(write.error, "Remove admin")}</p>}
      {receipt.isSuccess && write.data && <TxLink hash={write.data} chainId={chainId} />}
    </li>
  )
}

function RendererLockCard({
  collection,
  rendererLocked,
  canLock,
  onConfirmed,
}: {
  collection: Address
  rendererLocked: boolean
  canLock: boolean
  onConfirmed: () => void
}) {
  const chainId = useChainId()
  const [typed, setTyped] = useState("")
  const write = useWriteContract()
  const receipt = useWaitForTransactionReceipt({ hash: write.data })
  useEffect(() => {
    if (receipt.isSuccess) {
      setTyped("")
      onConfirmed()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [receipt.isSuccess])

  const busy = write.isPending || receipt.isLoading

  return (
    <div className="rounded border border-gray-200 p-3 space-y-2">
      <p className="text-sm font-medium">Renderer</p>
      <p className="text-xs text-gray-500 leading-relaxed">
        {rendererLocked
          ? "The renderer pointer is locked permanently. It cannot be repointed."
          : "The renderer pointer can still be changed. Locking it is permanent: the artwork can never be pointed at a different renderer afterward."}
      </p>
      {!rendererLocked && canLock && (
        <div className="flex items-stretch gap-2">
          <input
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            placeholder='Type "LOCK" to confirm'
            disabled={busy}
            className={`${INPUT} flex-1`}
          />
          <button
            type="button"
            disabled={typed !== "LOCK" || busy}
            onClick={() =>
              write.writeContract({
                address: collection,
                abi: surfaceAbi,
                functionName: "lockRenderer",
              })
            }
            className={BTN_SECONDARY}
          >
            {write.isPending ? "Confirm in wallet…" : receipt.isLoading ? "Locking…" : "Lock renderer"}
          </button>
        </div>
      )}
      {write.error && <p className={ERROR}>{formatWriteError(write.error, "Lock renderer")}</p>}
      {receipt.isSuccess && write.data && <TxLink hash={write.data} chainId={chainId} />}
    </div>
  )
}

export function AdminsPanel({ collection }: { collection: Address }) {
  const { address: connected } = useAccount()
  const [state, setState] = useState<AuthorityState | null | undefined>(undefined)

  const refetch = useCallback(() => {
    setState(undefined)
    void fetchAuthorityState(collection).then(setState)
  }, [collection])

  useEffect(() => {
    refetch()
  }, [refetch])

  const loading = state === undefined
  const resolved = loading ? null : state
  const role = roleOf(resolved, connected)

  return (
    <div className="space-y-6">
      <RoleCard loading={loading} state={resolved} role={role} />

      {resolved && (
        <div className="space-y-2">
          <p className="text-[10px] font-mono uppercase tracking-wider text-gray-400">Admins</p>
          {resolved.admins.length === 0 ? (
            <p className="text-[11px] font-mono text-gray-400">No admins granted.</p>
          ) : (
            <ul className="divide-y divide-gray-200 rounded-md border border-gray-200">
              {resolved.admins.map((a) => (
                <AdminRow
                  key={a}
                  collection={collection}
                  admin={a}
                  canRemove={role === "owner" || (role === "admin" && !!connected && connected.toLowerCase() === a.toLowerCase())}
                  onConfirmed={refetch}
                />
              ))}
            </ul>
          )}
        </div>
      )}

      {role === "owner" && <AddAdminForm collection={collection} onConfirmed={refetch} />}

      {resolved && (
        <RendererLockCard
          collection={collection}
          rendererLocked={resolved.rendererLocked}
          canLock={role === "owner" || role === "admin"}
          onConfirmed={refetch}
        />
      )}

      <p className="text-[10px] font-mono text-gray-400 leading-relaxed border-t border-gray-100 pt-4">
        The admin list above is reconstructed from this collection&apos;s own
        event history, cached briefly, rather than served from an indexed
        table: it can take up to thirty seconds to reflect a transaction
        you just confirmed.
      </p>
    </div>
  )
}
