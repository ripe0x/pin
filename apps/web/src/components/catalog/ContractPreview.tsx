"use client"

import { useContractInfo } from "./useContractInfo"

/**
 * Confidence card rendered below the contract-address input in
 * `AddEntryForm`. Behavior:
 *
 *   - input empty or invalid          → nothing renders
 *   - lookup in flight                → loading shimmer
 *   - bytecode missing                → soft warning (still submit-able)
 *   - bytecode present, no name/etc.  → "Contract found" with short addr
 *   - bytecode present + name/symbol  → name, symbol, standard chip,
 *                                       total supply when available
 *
 * Per the registry's "no semantic checks" rule, this is purely
 * informational. The form never blocks submission based on these
 * results — it only tells the artist what we see at that address.
 */
export function ContractPreview({ address }: { address: string }) {
  const { data, isLoading } = useContractInfo(address)

  if (!address.trim()) return null

  if (isLoading) {
    return (
      <div className="border border-gray-200 rounded-md p-3 text-xs text-gray-500 animate-pulse">
        Looking up contract...
      </div>
    )
  }

  if (!data) return null

  if (!data.hasBytecode) {
    return (
      <div className="border border-amber-200 bg-amber-50 rounded-md p-3 text-xs text-amber-800">
        No contract code at this address. You can still declare it, but
        double-check the address.
      </div>
    )
  }

  const standard = data.isERC721
    ? "ERC-721"
    : data.isERC1155
      ? "ERC-1155"
      : null
  const supply =
    data.totalSupply !== null
      ? `${formatCount(data.totalSupply)} ${
          data.totalSupply === "1" ? "token" : "tokens"
        }`
      : null

  return (
    <div className="border border-gray-200 rounded-md p-3 space-y-1.5 text-sm">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="min-w-0 truncate font-medium">
          {data.name ?? "Contract found"}
        </div>
        <div className="flex items-center gap-2 text-[11px] text-gray-500 shrink-0">
          {standard && <Chip>{standard}</Chip>}
          {data.symbol && <span className="font-mono">{data.symbol}</span>}
          {supply && <span>· {supply}</span>}
        </div>
      </div>
      {!standard && (
        <p className="text-xs text-amber-700">
          Not a recognized NFT standard. The registry will still accept it.
        </p>
      )}
    </div>
  )
}

function Chip({ children }: { children: React.ReactNode }) {
  return (
    <span className="border border-gray-200 rounded-full px-2 py-0.5">
      {children}
    </span>
  )
}

function formatCount(s: string): string {
  // 13-digit totals look silly; group with commas. Bigints up to 2^256
  // would overflow Number — but real NFT supplies fit fine, so use
  // the safe fast path for reasonable values and fall back to raw.
  try {
    const n = BigInt(s)
    if (n < 1_000_000_000n) {
      return Number(n).toLocaleString()
    }
  } catch {
    // fall through
  }
  return s
}
