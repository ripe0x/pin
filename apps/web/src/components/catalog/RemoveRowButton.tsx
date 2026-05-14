"use client"

import { useCatalogWrite, type CatalogFunctionName } from "./useCatalogWrite"
import { extractShortError } from "./catalogErrors"

type Args = readonly (`0x${string}` | bigint)[]

/**
 * Small inline button used on each row to call a registry remove
 * function. Shared by the three pointer-type sections so the wagmi
 * lifecycle stays scoped to one row at a time.
 */
export function RemoveRowButton({
  fn,
  args,
  label = "Remove",
}: {
  fn: CatalogFunctionName
  args: Args
  label?: string
}) {
  const { call, busy, error, reset } = useCatalogWrite()
  function onClick() {
    reset()
    call(fn, args)
  }
  return (
    <div className="flex flex-col items-end gap-1">
      <button
        type="button"
        onClick={onClick}
        disabled={busy}
        className="text-xs border border-gray-200 px-3 py-1.5 rounded-full hover:border-amber-400 hover:text-amber-700 transition-colors shrink-0 disabled:opacity-50"
      >
        {busy ? "Removing..." : label}
      </button>
      {error && (
        <span className="text-[11px] text-amber-700 text-right max-w-[200px]">
          {extractShortError(error)}
        </span>
      )}
    </div>
  )
}
