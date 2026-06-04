import { getEvmNowTxUrl } from "@/lib/explorer"
import { durabilityLabel } from "@/lib/editions-durability"

/**
 * Presentational status for the "fund a permanent Arweave floor copy" flow
 * (Phase 2 of docs/editions-permanence-funding.md). Shared by the live owner
 * panel (PermanenceFloorPanel) and the demo/showcase route, so both render an
 * identical visual. No wallet/chain/DB imports — pure props in.
 *
 * The flow spends the artist's permanence vault to upload a durable Arweave copy
 * via the Irys rail, then registers its URIs as MURI fallbacks. The realized
 * durability is EARNED: "permanent-floor" only once arweave.net resolves, else
 * the honest "irys-stored".
 */

export type FloorState =
  | "needs-anchor" // edition not anchored in MURI yet — do that first
  | "idle" // ready to fund a floor copy
  | "uploading" // paying Irys + uploading the Arweave copy
  | "registering" // writing the URIs into MURI as fallbacks
  | "floored" // done; arweave.net resolved → permanent floor
  | "irys-stored" // done; durable on Irys, Arweave settlement not yet confirmed
  | "error"

const LABEL = "text-[10px] font-mono uppercase tracking-[0.1em] text-fg-subtle"
const HELP = "text-xs leading-relaxed text-fg-muted"
const BTN =
  "w-full bg-fg px-3 py-2.5 text-[10px] font-mono uppercase tracking-[0.1em] text-bg hover:opacity-80 transition-opacity disabled:opacity-40 disabled:cursor-not-allowed"

export function PermanenceFloorStatus({
  state,
  arweaveUri,
  txHash,
  error,
  chainId,
  onFund,
  busy,
}: {
  state: FloorState
  arweaveUri?: string
  txHash?: `0x${string}`
  error?: string
  chainId: number
  onFund?: () => void
  busy?: boolean
}) {
  return (
    <div className="space-y-3">
      <p className={HELP}>
        Spend this work&rsquo;s permanence vault on a <span className="text-fg">pay-once
        Arweave copy</span>, registered as a MURI fallback so the onchain viewer
        can always find a surviving copy. Paid from your wallet (withdraw your
        vault balance first if needed). PND never holds the funds or the media.
      </p>

      <div className="space-y-2.5 border border-border bg-surface-muted/40 p-3">
        {state === "needs-anchor" ? (
          <p className={HELP}>
            Anchor this edition&rsquo;s artwork in MURI first (the{" "}
            <span className="text-fg">Preserve onchain</span> step above), then
            fund a permanent floor copy here.
          </p>
        ) : state === "floored" || state === "irys-stored" ? (
          <div className="space-y-2">
            <div className="flex items-center gap-2 text-xs">
              <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-status-available text-[9px] font-mono text-white">
                ✓
              </span>
              <span className="text-fg">
                {state === "floored"
                  ? durabilityLabel("permanent-floor")
                  : "Stored via Irys — Arweave settlement pending"}
              </span>
            </div>
            {arweaveUri && (
              <p className="break-all font-mono text-[10px] text-fg-subtle">{arweaveUri}</p>
            )}
            {state === "irys-stored" && (
              <p className="text-[10px] font-mono leading-relaxed text-fg-subtle">
                The copy is live on Irys. It upgrades to a permanent floor once
                arweave.net resolves it (re-checked automatically).
              </p>
            )}
          </div>
        ) : (
          <>
            <div className="flex items-center justify-between gap-3">
              <span className={LABEL}>Permanent floor</span>
              <span className="font-mono text-[10px] text-fg-subtle">
                {state === "uploading"
                  ? "Uploading to Arweave…"
                  : state === "registering"
                    ? "Registering in MURI…"
                    : "one-time"}
              </span>
            </div>
            <button onClick={onFund} disabled={busy || !onFund || state !== "idle"} className={BTN}>
              {state === "uploading"
                ? "Uploading…"
                : state === "registering"
                  ? "Confirming…"
                  : "Fund a permanent floor copy"}
            </button>
          </>
        )}

        {txHash && (
          <p className="text-[10px] font-mono text-fg-subtle">
            <a
              className="underline hover:text-fg"
              href={getEvmNowTxUrl(txHash)}
              target="_blank"
              rel="noopener noreferrer"
            >
              {txHash.slice(0, 10)}…↗
            </a>
          </p>
        )}
        {state === "error" && error && (
          <p className="text-xs text-red-500 break-words">{error}</p>
        )}
      </div>
    </div>
  )
}
