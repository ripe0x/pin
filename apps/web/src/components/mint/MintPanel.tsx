"use client"

/**
 * Generic mint CTA for the `/mint/[contract]` surface — the standard SKIN
 * over the headless engine in use-mint-engine.ts (which owns all descriptor
 * semantics: phases, quote, eligibility, selection, args, write → receipt →
 * reveal). Curated layouts (Homage's gallery register) drive the same engine
 * with their own presentation; this component only renders.
 *
 * Supports both shapes:
 *   - quantity mints  (`quantity: true`)  → quantity selector, value = price*qty
 *   - single mints     (`quantity: false`) → one token, value = price
 *     (Vouch: one-per-wallet chosen-seat `mint(uint256 tokenId)` gated by
 *     `hasMinted`, seat picked via the selector slot + args builder)
 */

import Link from "next/link"
import { useRouter } from "next/navigation"
import { formatEther } from "viem"
import { ConnectButton } from "@rainbow-me/rainbowkit"
import {
  Countdown,
  PREFERRED_CHAIN,
  PREFERRED_CHAIN_LABEL,
  TxSuccessBanner,
  formatWriteError,
} from "@/components/tx/tx-ui"
import type { MintSnapshot } from "@/lib/mint-onchain"
import { useMintEngine } from "./use-mint-engine"
import { PhaseSelectorSlot } from "./mint-slots"

function trimEth(s: string): string {
  return s.includes(".") ? s.replace(/\.?0+$/, "") : s
}

export function MintPanel({
  collectionId,
  snapshot,
  selectorData,
}: {
  /** Slug or address — resolved against the registry client-side. */
  collectionId: string
  snapshot: MintSnapshot
  /**
   * Server-fetched context forwarded to the selector component (Vouch: the
   * seat states the page already read for SeatGrid) so pickers don't re-read
   * what the server render fetched.
   */
  selectorData?: unknown
}) {
  const m = useMintEngine(collectionId, snapshot)
  const router = useRouter()

  if (!m.desc) return null
  const desc = m.desc

  const isWritePending = m.busy === "confirm"
  const isTxPending = m.busy === "pending"

  const { dot, label } = m.mintable
    ? {
        dot: "bg-emerald-500 animate-pulse",
        label: m.activePhase ? `Live · ${m.activePhase.label}` : "Live",
      }
    : m.notStarted
      ? { dot: "bg-amber-500", label: "Not open yet" }
      : m.soldOut
        ? {
            dot: "bg-gray-400",
            label: desc.supplyLabel === "outstanding" ? "Fully outstanding" : "Fully minted",
          }
        : m.alreadyMinted
          ? { dot: "bg-gray-400", label: "You hold one" }
          : m.phaseState && !m.phaseState.anyScheduled
            ? { dot: "bg-gray-400", label: "Not scheduled" }
            : { dot: "bg-gray-400", label: "Mint closed" }

  return (
    <section className="py-5 border-b border-gray-100">
      <div className="rounded-lg border border-gray-200 bg-surface overflow-hidden">
        <div className="p-5 space-y-4">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <span className={`inline-block h-1.5 w-1.5 rounded-full ${dot}`} />
              <span className="text-[10px] font-mono uppercase tracking-wider text-gray-500">
                {label}
              </span>
            </div>
            <span className="text-[10px] font-mono uppercase tracking-wider text-gray-400 tabular-nums">
              {m.supplyText}
            </span>
          </div>

          {m.pct !== null && (
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-gray-100">
              <div className="h-full bg-fg transition-all" style={{ width: `${m.pct}%` }} />
            </div>
          )}

          <div className="flex items-end justify-between gap-6">
            <div className="space-y-1">
              <p className="text-[10px] font-mono uppercase tracking-wider text-gray-400">Price</p>
              <p className="text-2xl font-mono font-medium tabular-nums tracking-tight leading-none">
                {m.quoted && !m.quoteState.quote ? (
                  <span className="text-sm font-mono text-gray-500">
                    {m.quoteState.status === "error" ? "Quote unavailable" : "Fetching quote…"}
                  </span>
                ) : m.gasOnly ? (
                  <>
                    Gas only{" "}
                    <span className="text-sm font-mono text-gray-500">· you pay network gas</span>
                  </>
                ) : (
                  <>
                    {trimEth(formatEther(m.price))}{" "}
                    <span className="text-sm font-mono text-gray-500">ETH</span>
                  </>
                )}
              </p>
            </div>
            {m.countdownTo > 0n && m.countdownLabel && (
              <div className="text-right space-y-1">
                <p className="text-[10px] font-mono uppercase tracking-wider text-gray-400">
                  {m.countdownLabel}
                </p>
                <p className="text-sm font-mono tabular-nums leading-none">
                  <Countdown endTime={m.countdownTo} nowSec={m.nowSec} />
                </p>
              </div>
            )}
          </div>

          {/* Quote breakdown + manual refresh (2.2). */}
          {m.quoted && m.quoteState.quote && (
            <div className="space-y-1.5">
              {m.quoteState.quote.breakdown.map((line) => (
                <div key={line.label} className="flex items-baseline justify-between">
                  <span className="text-[10px] font-mono uppercase tracking-wider text-gray-400">
                    {line.label}
                  </span>
                  <span className="text-[11px] font-mono tabular-nums text-gray-500">
                    {trimEth(formatEther(line.wei))} ETH
                  </span>
                </div>
              ))}
              <div className="flex items-baseline justify-between gap-2">
                <span className="text-[10px] font-mono text-gray-400">
                  {m.quoteState.quote.note ?? ""}
                </span>
                <button
                  type="button"
                  onClick={m.quoteState.refresh}
                  className="text-[10px] font-mono uppercase tracking-wider text-gray-400 underline hover:text-fg"
                >
                  Refresh quote
                </button>
              </div>
            </div>
          )}
          {m.quoted && m.quoteState.status === "error" && (
            <p className="text-[11px] font-mono text-red-500 break-words">
              Quote failed: {m.quoteState.error}{" "}
              <button
                type="button"
                onClick={m.quoteState.refresh}
                className="underline hover:text-fg"
              >
                Retry
              </button>
            </p>
          )}

          {m.isSuccess && m.txHash && (
            <>
              <TxSuccessBanner
                txHash={m.txHash}
                chainId={PREFERRED_CHAIN.id}
                message={`Minted. Your ${m.noun} is yours onchain.`}
                onDismiss={() => {
                  m.reset()
                  router.refresh()
                }}
              />
              {/* Reveal step (2.4): link straight to the drawn token. */}
              {desc.reveal && m.revealedTokenId !== null && (
                <Link
                  href={`/mint/${collectionId}/${m.revealedTokenId.toString()}`}
                  className="block w-full text-center text-[11px] font-mono font-medium uppercase tracking-wider py-3 bg-fg text-bg hover:opacity-80 transition-colors"
                >
                  See your {m.noun} · #{m.revealedTokenId.toString()}
                </Link>
              )}
            </>
          )}

          {m.mintable && !(m.isSuccess && m.txHash) && (
            <>
              {/* Eligibility state (2.3): reason text, positive or negative. */}
              {m.eligibilityState.status === "checking" && (
                <p className="text-[11px] font-mono text-gray-500">Checking eligibility…</p>
              )}
              {m.eligibilityState.status === "error" && (
                <p className="text-[11px] font-mono text-red-500 break-words">
                  Eligibility check failed: {m.eligibilityState.error}{" "}
                  <button
                    type="button"
                    onClick={m.eligibilityState.refresh}
                    className="underline hover:text-fg"
                  >
                    Retry
                  </button>
                </p>
              )}
              {m.eligibilityState.status === "ready" && m.eligibilityState.result?.reason && (
                <p className="text-[11px] font-mono text-gray-500 leading-relaxed">
                  {m.eligibilityState.result.reason}
                </p>
              )}

              {/* Selector slot (Vouch: seat picker; Homage: punk picker)
                  feeding `selection` into the args builder. */}
              {m.selectorKey && !m.ineligible && (
                <PhaseSelectorSlot
                  selectorKey={m.selectorKey}
                  phaseKey={m.activePhase?.key ?? null}
                  eligibilityData={m.eligibilityState.result?.data}
                  serverData={selectorData}
                  selection={m.selection}
                  onSelect={m.setSelection}
                  disabled={m.isPending}
                />
              )}

              {desc.quantity && (
                <label className="block">
                  <span className="sr-only">Number to mint</span>
                  <div className="flex items-stretch border border-gray-200 focus-within:border-gray-400 transition-colors">
                    <input
                      type="number"
                      min={1}
                      step={1}
                      inputMode="numeric"
                      value={m.amount}
                      onChange={(e) => {
                        const n = parseInt(e.target.value, 10)
                        m.setAmount(Number.isNaN(n) ? 0 : n)
                      }}
                      disabled={m.isPending}
                      className="flex-1 px-3 py-3 text-sm font-mono tabular-nums outline-none disabled:opacity-40"
                    />
                    <span className="flex items-center px-3 text-[11px] font-mono uppercase tracking-wider text-gray-400 border-l border-gray-200">
                      {m.amount === 1 ? desc.tokenNoun : `${desc.tokenNoun}s`}
                    </span>
                  </div>
                </label>
              )}

              {!m.gasOnly && !(m.quoted && !m.quoteState.quote) && (
                <div className="flex items-baseline justify-between">
                  <span className="text-[10px] font-mono uppercase tracking-wider text-gray-400">
                    You pay
                  </span>
                  <span className="text-sm font-mono tabular-nums">{trimEth(formatEther(m.total))} ETH</span>
                </div>
              )}

              {m.balanceWei !== null && (
                <div className="flex justify-end">
                  <span className="text-[10px] font-mono uppercase tracking-wider text-gray-400 tabular-nums">
                    Balance: {Number(formatEther(m.balanceWei)).toFixed(3)} ETH
                  </span>
                </div>
              )}

              {!m.address ? (
                <ConnectButton.Custom>
                  {({ openConnectModal }) => (
                    <button
                      onClick={openConnectModal}
                      className="block w-full text-center text-[11px] font-mono font-medium uppercase tracking-wider py-3 bg-fg text-bg hover:opacity-80 transition-colors"
                    >
                      Connect wallet to mint
                    </button>
                  )}
                </ConnectButton.Custom>
              ) : m.wrongNetwork ? (
                <button
                  type="button"
                  onClick={() => m.switchChain({ chainId: PREFERRED_CHAIN.id })}
                  disabled={m.isSwitchPending}
                  className="block w-full text-center text-[11px] font-mono font-medium uppercase tracking-wider py-3 bg-fg text-bg hover:opacity-80 transition-colors disabled:opacity-40"
                >
                  {m.isSwitchPending ? "Switching…" : `Switch to ${PREFERRED_CHAIN_LABEL}`}
                </button>
              ) : (
                <button
                  onClick={() => void m.mint()}
                  disabled={
                    m.isPending ||
                    !m.amountValid ||
                    m.quoteBlocked ||
                    m.needsSelection ||
                    m.ineligible ||
                    m.eligibilityState.status === "checking" ||
                    m.eligibilityState.status === "error"
                  }
                  className="block w-full text-center text-[11px] font-mono font-medium uppercase tracking-wider py-3 bg-fg text-bg hover:opacity-80 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  {isWritePending
                    ? "Confirm in wallet…"
                    : isTxPending
                      ? "Minting…"
                      : m.needsSelection
                        ? `Pick a ${m.noun} to mint`
                        : m.gasOnly
                          ? "Mint (gas only)"
                          : m.quoted && !m.quoteState.quote
                            ? "Quote unavailable"
                            : `Mint for ${trimEth(formatEther(m.total))} ETH`}
                </button>
              )}

              {(m.writeError || m.receiptError || m.buildError) && (
                <p className="text-[11px] font-mono text-red-500 break-words">
                  {m.buildError ?? formatWriteError(m.writeError ?? m.receiptError, "Mint")}
                </p>
              )}
            </>
          )}

          {!m.mintable && !(m.isSuccess && m.txHash) && m.ready && (
            <p className="text-[11px] font-mono text-gray-500 leading-relaxed">
              {m.notStarted
                ? "This mint hasn't opened yet."
                : m.soldOut
                  ? desc.supplyLabel === "outstanding"
                    ? `Every ${desc.tokenNoun} is currently outstanding.`
                    : `Every ${desc.tokenNoun} has been minted.`
                  : m.alreadyMinted
                    ? `You already hold a ${desc.tokenNoun} from this collection (one per wallet).`
                    : m.phaseState && !m.phaseState.anyScheduled
                      ? "No mint window has been scheduled yet."
                      : "This mint is closed."}
            </p>
          )}
        </div>
      </div>
    </section>
  )
}
