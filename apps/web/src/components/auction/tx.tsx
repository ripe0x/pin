/**
 * Tiny presentational helpers for transaction + address feedback. evm.now
 * links resolve on real mainnet; on a local fork they return 404 but the hash
 * is still useful for debugging the local chain via `cast tx <hash>`.
 */

import type { ItemStatus } from "@/lib/useBatchedCalls"

const STATUS_LABEL: Record<ItemStatus["state"], string> = {
  idle: "Queued",
  confirming: "Awaiting signature",
  mining: "Confirming",
  done: "Done",
  failed: "Failed",
  skipped: "Skipped",
}

/** Per-row progress chip for a `useBatchedCalls` run. */
export function StatusChip({ status }: { status: ItemStatus | undefined }) {
  const state = status?.state ?? "idle"
  const tone =
    state === "done"
      ? "text-green-700 bg-green-50"
      : state === "failed"
        ? "text-red-700 bg-red-50"
        : state === "skipped"
          ? "text-gray-500 bg-gray-100"
          : "text-gray-700 bg-gray-100"
  const detail =
    status?.state === "failed"
      ? `: ${status.error}`
      : status?.state === "skipped"
        ? `: ${status.reason}`
        : ""
  return (
    <span className={`text-[11px] px-1.5 py-0.5 rounded ${tone}`}>
      {STATUS_LABEL[state]}
      {detail}
    </span>
  )
}

function shortHash(hash: string): string {
  return `${hash.slice(0, 10)}…${hash.slice(-6)}`
}

function shortAddress(addr: string): string {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`
}

export function TxLink({
  hash,
  label = "View transaction",
}: {
  hash: `0x${string}`
  label?: string
}) {
  return (
    <a
      href={`https://evm.now/tx/${hash}?chainId=1`}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex items-baseline gap-1 text-xs text-gray-600 hover:text-fg underline-offset-2 hover:underline"
    >
      <span>{label}</span>
      <span className="font-mono text-gray-400">{shortHash(hash)}</span>
      <span aria-hidden>↗</span>
    </a>
  )
}

export function AddressLink({
  address,
  label,
}: {
  address: string
  label: string
}) {
  return (
    <a
      href={`https://evm.now/address/${address}?chainId=1`}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex items-baseline gap-1 text-xs text-gray-600 hover:text-fg underline-offset-2 hover:underline"
    >
      <span>{label}</span>
      <span className="font-mono text-gray-400">{shortAddress(address)}</span>
      <span aria-hidden>↗</span>
    </a>
  )
}
