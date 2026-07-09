"use client"

// The terminal-register mint block — compact mono price / context / action /
// status, ported from the Homage site's TermMint (permanence
// origin/master:web/components/TermMint.tsx) and driven by PND's generic mint
// engine instead of the Homage repo's controller. Every dynamic line reserves
// its height so the surrounding lockup never shifts.
//
// The claim window renders the registered HomagePunkPicker (chips of
// claimable punks + verified manual id — a superset of the original's bare id
// field, with the same delegate.xyz / pay-for-holder routing).

import { formatEther } from "viem"
import { ConnectButton } from "@rainbow-me/rainbowkit"
import { PREFERRED_CHAIN, PREFERRED_CHAIN_LABEL } from "@/components/tx/tx-ui"
import { isSlippageError } from "@/lib/mint-modules/homage"
import { PhaseSelectorSlot } from "../mint-slots"
import type { MintEngine } from "../use-mint-engine"
import { AllowlistCheck } from "./AllowlistCheck"

function eth(wei: bigint): string {
  const s = formatEther(wei)
  return s.includes(".") ? s.replace(/(\.\d{0,5}\d*?)0+$/, "$1").replace(/\.$/, "") : s
}

export function HomageTermMint({ m, selectorData }: { m: MintEngine; selectorData?: unknown }) {
  const busy = m.busy
  const phaseKey = m.activePhase?.key ?? null
  const rawError = m.buildError ? null : (m.writeError ?? m.receiptError)
  const slippage = isSlippageError(rawError)
  const error = m.buildError ?? (rawError && !slippage ? firstLine(rawError.message) : null)

  const price = m.quoted ? m.quoteState.quote?.value : m.total

  const contextLine = (() => {
    if (phaseKey === "public")
      return "a random punk, drawn at mint · the fee rises a little with each mint from your wallet"
    if (phaseKey === "allowlist") {
      if (!m.address) return "a random punk, drawn at mint · connect to check eligibility"
      if (m.eligibilityState.status === "checking") return "checking the allowlist…"
      return m.eligibilityState.result?.reason ?? "a random punk, drawn at mint"
    }
    // claim
    if (!m.address) return "own a punk? connect, then pick or enter its id · the button mints its exact homage"
    if (m.eligibilityState.status === "checking") return "finding your claimable punks…"
    return m.eligibilityState.result?.reason ?? "pick the punk whose homage to mint"
  })()

  const selectedId =
    m.selection && typeof m.selection === "object" && "id" in m.selection
      ? (m.selection as { id: number }).id
      : typeof m.selection === "number"
        ? m.selection
        : null

  const busyLabel =
    busy === "confirm" ? "Confirm in wallet…" : busy === "pending" ? "Drawing your punk…" : null
  const idleLabel = phaseKey === "claim" ? `Mint #${selectedId ?? "…"}` : "Mint a random homage"
  const blocked =
    m.isPending ||
    m.quoteBlocked ||
    m.needsSelection ||
    m.ineligible ||
    m.eligibilityState.status === "checking" ||
    m.eligibilityState.status === "error" ||
    !m.mintable

  let action: React.ReactNode
  if (busy) {
    action = (
      <button disabled className="btn-primary">
        <span className="spinner" />
        {busyLabel}
      </button>
    )
  } else if (!m.address) {
    action = (
      <ConnectButton.Custom>
        {({ openConnectModal }) => (
          <button onClick={openConnectModal} className="btn-primary">
            Connect wallet
          </button>
        )}
      </ConnectButton.Custom>
    )
  } else if (m.wrongNetwork) {
    action = (
      <button
        type="button"
        onClick={() => m.switchChain({ chainId: PREFERRED_CHAIN.id })}
        disabled={m.isSwitchPending}
        className="btn-primary"
      >
        {m.isSwitchPending ? "Switching…" : `Switch to ${PREFERRED_CHAIN_LABEL}`}
      </button>
    )
  } else {
    action = (
      <button onClick={() => void m.mint()} disabled={blocked} className="btn-primary">
        {idleLabel}
      </button>
    )
  }

  return (
    <div className="w-full max-w-[380px]">
      {/* price */}
      <div className="flex items-end justify-between gap-4">
        <div>
          <div className="colo-label">price</div>
          <div className="mt-1.5 font-mono text-[22px] font-semibold leading-none tabular-nums text-(--ink)">
            {price !== undefined && price !== null && !(m.quoted && !m.quoteState.quote)
              ? eth(price)
              : m.quoteState.status === "loading"
                ? "…"
                : "—"}{" "}
            <span className="text-[12px] font-medium text-(--dim)">ETH</span>
          </div>
        </div>
        <div className="flex items-center gap-2 pb-0.5">
          {slippage && (
            <span className="font-mono text-[10px] leading-tight text-(--accent) text-right max-w-[16ch]">
              price moved · refresh &amp; retry
            </span>
          )}
          {m.quoted && (
            <button
              onClick={m.quoteState.refresh}
              disabled={m.quoteState.status === "loading"}
              title="refresh quote"
              className="font-mono text-[12px] text-(--dim) hover:text-(--ink) disabled:opacity-40"
            >
              ↻
            </button>
          )}
        </div>
      </div>

      {/* claim window — the punk picker (chips + verified manual id) */}
      {phaseKey === "claim" && m.selectorKey && !m.ineligible && (
        <div className="mt-3">
          <PhaseSelectorSlot
            selectorKey={m.selectorKey}
            phaseKey={phaseKey}
            eligibilityData={m.eligibilityState.result?.data}
            serverData={selectorData}
            selection={m.selection}
            onSelect={m.setSelection}
            disabled={m.isPending}
          />
        </div>
      )}

      {/* context / eligibility — reserved two lines so the lockup never shifts */}
      <p className="font-mono text-[11px] text-(--dim) mt-2 leading-relaxed min-h-8">{contextLine}</p>

      <div className="mt-3">{action}</div>

      {/* tx status / errors — reserved */}
      <div className="mt-2 font-mono text-[11px] min-h-4 leading-relaxed">
        {busy === "confirm" ? (
          <span className="text-(--dim)">waiting for your signature…</span>
        ) : busy === "pending" ? (
          <span className="text-(--dim)">tx mining · the wheel decides…</span>
        ) : error ? (
          <span className="text-(--accent) break-words">{error}</span>
        ) : m.quoted && m.quoteState.status === "error" ? (
          <span className="text-(--accent) break-words">quote failed: {m.quoteState.error}</span>
        ) : null}
      </div>

      {/* quote breakdown */}
      {m.quoted && m.quoteState.quote && (
        <details className="mt-3 group">
          <summary className="font-mono text-[11px] text-(--dim) hover:text-(--ink) cursor-pointer list-none marker:content-none">
            <span className="group-open:hidden">▸ what the price covers</span>
            <span className="hidden group-open:inline">▾ what the price covers</span>
          </summary>
          <div className="mt-2 space-y-1.5">
            {m.quoteState.quote.breakdown.map((line) => (
              <div key={line.label} className="flex items-baseline justify-between">
                <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-(--faint)">
                  {line.label}
                </span>
                <span className="font-mono text-[11px] tabular-nums text-(--dim)">
                  {eth(line.wei)} ETH
                </span>
              </div>
            ))}
            {m.quoteState.quote.note && (
              <p className="font-mono text-[10px] text-(--faint) leading-relaxed">
                {m.quoteState.quote.note}
              </p>
            )}
          </div>
        </details>
      )}

      {/* Allowlist checker — shown in every phase up to public (claim +
          allowlist here; the pre-mint teaser renders it directly from the
          layout, where this block doesn't mount). Moot once public opens. */}
      {phaseKey !== "public" && (
        <div className="mt-3">
          <AllowlistCheck />
        </div>
      )}
    </div>
  )
}

function firstLine(s: string): string {
  return s.split("\n")[0]
}
