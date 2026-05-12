import type { Address } from "viem"
import type { ContractMapEntry, Confidence } from "@/lib/contract-classifier"
import { DeclareInRecordButton } from "./DeclareInRecordButton"

const CONFIDENCE_STYLES: Record<Confidence, string> = {
  Known: "text-emerald-700",
  Detected: "text-emerald-700",
  NeedsReview: "text-amber-700",
  Unknown: "text-gray-400",
}

function shortAddr(addr: string) {
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`
}

export function ContractMapTable({
  artist,
  entries,
}: {
  artist: Address
  entries: ContractMapEntry[]
}) {
  if (entries.length === 0) {
    return (
      <p className="text-sm text-gray-500">
        PND did not identify any contracts holding work connected to this
        wallet.
      </p>
    )
  }
  return (
    <ul className="space-y-2">
      {entries.map((e) => (
        <li
          key={e.contract}
          className="border border-gray-200 rounded-md p-4 space-y-2"
        >
          <div className="flex items-start justify-between gap-4 flex-wrap">
            <div className="min-w-0 space-y-0.5">
              <div className="font-medium truncate">
                {e.name ?? e.label}
              </div>
              <div className="font-mono text-xs text-gray-400">
                {shortAddr(e.contract)}
              </div>
            </div>
            <div className="text-right shrink-0">
              <div className="text-xl font-semibold">{e.tokenCount}</div>
              <div className="text-[11px] text-gray-500 uppercase tracking-wide">
                {e.tokenCount === 1 ? "token" : "tokens"}
              </div>
            </div>
          </div>
          <div className="flex items-center justify-between flex-wrap gap-2 text-xs">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-gray-600">{e.label}</span>
              {e.system && (
                <span className="text-gray-400">· {e.system}</span>
              )}
              {e.kind && (
                <span className="text-gray-400">· {e.kind}</span>
              )}
              {e.declaredInRegistry && (
                <span className="text-[11px] uppercase tracking-wide text-emerald-700 border border-emerald-300 bg-emerald-50 rounded-full px-2 py-0.5">
                  Declared in record
                </span>
              )}
            </div>
            <span
              className={`text-[11px] uppercase tracking-wide ${CONFIDENCE_STYLES[e.confidence]}`}
            >
              {e.confidence === "NeedsReview" ? "Needs review" : e.confidence}
            </span>
          </div>
          {e.note && <p className="text-sm text-gray-600">{e.note}</p>}
          {!e.declaredInRegistry && (
            <div className="flex justify-end">
              <DeclareInRecordButton artist={artist} contract={e.contract} />
            </div>
          )}
        </li>
      ))}
    </ul>
  )
}
