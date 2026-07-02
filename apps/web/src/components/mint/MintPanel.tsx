"use client"

/**
 * Generic mint CTA for the `/mint/[contract]` surface. Generalized from the
 * Editions `MintEditionCTA`: it reads everything it needs from the collection
 * descriptor (price/window/gate/mint fn), so a new standard ERC-721 is a
 * registry entry, not a new component.
 *
 * Supports both shapes:
 *   - quantity mints  (`quantity: true`)  → quantity selector, value = price*qty
 *   - single mints     (`quantity: false`) → one token, value = price
 *     (Vouch: one-per-wallet chosen-seat `mint(uint256 tokenId)` gated by
 *     `hasMinted`, seat picked via the selector slot + args builder)
 *
 * Phased / gen-art extensions (all descriptor-driven, inert for plain mints):
 *   - `phases` — claim/allowlist/public schedule resolved from the snapshot's
 *     window bounds (mint-phases.ts) against the RPC-frugal chain clock; the
 *     active phase supplies mintFn, eligibility, args, price and copy.
 *   - `price: { kind: "quote" }` / per-phase `priceQuote` — msg.value from a
 *     registered quote provider, refreshed visibility-gated (mint-hooks.ts),
 *     with a breakdown + manual refresh in the price block.
 *   - per-phase `eligibility` / `argsBuilder` / `selector` — wallet gating,
 *     calldata, and an optional picker, all looked up from the registries.
 *   - `reveal` — parse the drawn tokenId from the mint receipt and link to
 *     `/mint/[contract]/[tokenId]` (mint-reveal.ts, zero extra RPC).
 */

import { useMemo, useState } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { formatEther } from "viem"
import {
  useAccount,
  useBalance,
  useChainId,
  usePublicClient,
  useReadContract,
  useSwitchChain,
  useWaitForTransactionReceipt,
  useWriteContract,
} from "wagmi"
import { ConnectButton } from "@rainbow-me/rainbowkit"
import {
  Countdown,
  PREFERRED_CHAIN,
  PREFERRED_CHAIN_LABEL,
  TxSuccessBanner,
  formatWriteError,
  useChainNowSec,
} from "@/components/tx/tx-ui"
import { resolveMintCollection } from "@/lib/mint-collections"
import type { MintSnapshot } from "@/lib/mint-onchain"
import { resolvePhaseState } from "@/lib/mint-phases"
import { extractRevealTokenId } from "@/lib/mint-reveal"
import { getArgsBuilder } from "@/lib/mint-registries"
import { useMintQuote, usePhaseEligibility } from "./mint-hooks"
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
  const desc = resolveMintCollection(collectionId)
  const { address } = useAccount()
  const chainId = useChainId()
  const client = usePublicClient()
  const { switchChain, isPending: isSwitchPending } = useSwitchChain()
  const nowSec = useChainNowSec()
  const router = useRouter()
  const wrongNetwork = !!address && chainId !== PREFERRED_CHAIN.id

  const [amount, setAmount] = useState(1)
  const [selection, setSelection] = useState<unknown>(undefined)
  const [buildError, setBuildError] = useState<string | null>(null)

  // ── phase resolution (2.1) — pure math over the snapshot, no RPC ──────────
  const phaseWindows = desc?.phases && snapshot.phases ? snapshot.phases : null
  const phaseState = phaseWindows ? resolvePhaseState(phaseWindows, nowSec) : null
  const activePhase =
    desc?.phases && phaseState && phaseState.activeIndex >= 0
      ? desc.phases[phaseState.activeIndex]
      : null
  const activeWindow =
    phaseWindows && phaseState && phaseState.activeIndex >= 0
      ? phaseWindows[phaseState.activeIndex]
      : null

  // ── provider keys (2.2/2.3): active phase's own keys win over the
  // collection-level defaults (which serve non-phased mints like Vouch) ─────
  const quoteKey =
    activePhase?.priceQuote ??
    (desc?.price.kind === "quote" ? desc.price.provider : null)
  const eligibilityKey = activePhase?.eligibility ?? desc?.eligibility ?? null
  const argsBuilderKey = activePhase?.argsBuilder ?? desc?.argsBuilder ?? null
  const selectorKey = activePhase?.selector ?? desc?.selector ?? null

  // ── dynamic pricing (2.2) — visibility-gated refresh ──────────────────────
  const quoteState = useMintQuote(quoteKey, activePhase?.key ?? null)

  // ── eligibility (2.3) — once per (wallet, phase), no polling ──────────────
  const eligibilityState = usePhaseEligibility(eligibilityKey, activePhase?.key ?? null)

  const { data: balance } = useBalance({
    address,
    chainId: PREFERRED_CHAIN.id,
    query: { enabled: !!address && !wrongNetwork },
  })

  const { data: alreadyMintedRaw } = useReadContract({
    address: desc?.address,
    abi: desc?.abi,
    functionName: desc?.alreadyMintedFn ?? "hasMinted",
    args: address ? [address] : undefined,
    chainId: PREFERRED_CHAIN.id,
    query: { enabled: !!address && !!desc?.alreadyMintedFn },
  })

  const {
    writeContract,
    data: txHash,
    isPending: isWritePending,
    error: writeError,
    reset,
  } = useWriteContract()
  const {
    isLoading: isTxPending,
    isSuccess,
    data: receipt,
  } = useWaitForTransactionReceipt({ hash: txHash })
  const isPending = isWritePending || isTxPending

  // ── post-mint reveal (2.4) — pure parse of the already-fetched receipt ────
  const revealedTokenId = useMemo(() => {
    if (!desc?.reveal || !isSuccess || !receipt) return null
    return extractRevealTokenId({
      reveal: desc.reveal,
      logs: receipt.logs,
      collection: desc.address,
      abi: desc.abi,
      minter: address,
    })
  }, [desc?.reveal, desc?.address, desc?.abi, isSuccess, receipt, address])

  if (!desc) return null

  const quoted = quoteKey !== null
  const price = quoted && quoteState.quote ? quoteState.quote.value : BigInt(snapshot.priceWei)
  const minted = BigInt(snapshot.minted)
  const cap = BigInt(snapshot.cap)
  const mintStart = BigInt(snapshot.mintStart)
  const mintEnd = BigInt(snapshot.mintEnd)
  const gasOnly = !quoted && price === 0n

  const qty = desc.quantity ? amount : 1
  const amountValid = !desc.quantity || (Number.isInteger(amount) && amount >= 1)
  const total = desc.quantity ? price * BigInt(qty) : price

  // Window state. Phased descriptors resolve from the phase schedule; plain
  // ones keep the original single-window math, byte for byte.
  let ready: boolean
  let notStarted: boolean
  let windowClosed: boolean
  if (phaseState) {
    ready = nowSec > 0
    notStarted = ready && !activePhase && phaseState.nextIndex >= 0
    windowClosed = ready && !activePhase && phaseState.nextIndex === -1
  } else {
    ready = nowSec > 0 || (mintStart === 0n && mintEnd === 0n)
    notStarted = mintStart > 0n && nowSec > 0 && BigInt(nowSec) < mintStart
    windowClosed = mintEnd > 0n && nowSec > 0 && BigInt(nowSec) >= mintEnd
  }
  const remaining = cap > 0n ? cap - minted : null
  const soldOut = remaining !== null && remaining <= 0n
  const alreadyMinted = !!desc.alreadyMintedFn && alreadyMintedRaw === true
  const ineligible =
    eligibilityState.status === "ready" && eligibilityState.result?.eligible === false
  const mintable =
    ready && !notStarted && !windowClosed && !soldOut && !alreadyMinted && (!phaseState || !!activePhase)

  const noun = activePhase?.noun ?? desc.tokenNoun
  const pct = cap > 0n ? Math.min(100, Math.round((Number(minted) / Number(cap)) * 100)) : null
  const supplyText =
    cap > 0n
      ? desc.supplyLabel === "outstanding"
        ? `${Number(minted)} of ${Number(cap)} outstanding`
        : `${Number(minted)} / ${Number(cap)} minted`
      : desc.supplyLabel === "outstanding"
        ? `${Number(minted)} outstanding`
        : `${Number(minted)} minted`

  const { dot, label } = mintable
    ? {
        dot: "bg-emerald-500 animate-pulse",
        label: activePhase ? `Live · ${activePhase.label}` : "Live",
      }
    : notStarted
      ? { dot: "bg-amber-500", label: "Not open yet" }
      : soldOut
        ? {
            dot: "bg-gray-400",
            label: desc.supplyLabel === "outstanding" ? "Fully outstanding" : "Fully minted",
          }
        : alreadyMinted
          ? { dot: "bg-gray-400", label: "You hold one" }
          : phaseState && !phaseState.anyScheduled
            ? { dot: "bg-gray-400", label: "Not scheduled" }
            : { dot: "bg-gray-400", label: "Mint closed" }

  // Countdown target: the active phase's close (which is also the next
  // phase's open), the next phase's open when nothing is live, or the plain
  // window's end. 0n renders no countdown.
  const countdownTo = phaseState
    ? activeWindow && BigInt(activeWindow.end) > 0n
      ? BigInt(activeWindow.end)
      : phaseState.nextStart
    : mintEnd > 0n && !windowClosed
      ? mintEnd
      : 0n
  const countdownLabel =
    phaseState && !activePhase
      ? phaseState.nextIndex >= 0
        ? `${phaseWindows![phaseState.nextIndex].label} opens in`
        : ""
      : phaseState && phaseState.nextIndex >= 0
        ? `${phaseWindows![phaseState.nextIndex].label} opens in`
        : "Closes in"

  // The quote's failure/staleness gates the button; a fixed price never does.
  const quoteBlocked = quoted && (quoteState.status !== "ready" || !quoteState.quote)
  // A declared selector means the mint needs a choice (Vouch: which seat).
  const needsSelection = !!selectorKey && selection == null

  async function handleMint() {
    if (!desc || !amountValid || !mintable) return
    setBuildError(null)
    const fn = activePhase?.mintFn ?? desc.mintFn
    let args: unknown[] = desc.quantity ? [BigInt(qty)] : []
    if (argsBuilderKey) {
      const builder = getArgsBuilder(argsBuilderKey)
      if (!builder || !client) {
        setBuildError(`Args builder "${argsBuilderKey}" is not registered`)
        return
      }
      try {
        args = await builder({
          client,
          wallet: address,
          phaseKey: activePhase?.key ?? null,
          selection,
          eligibilityData: eligibilityState.result?.data,
        })
      } catch (e) {
        setBuildError(e instanceof Error ? e.message.split("\n")[0] : "Could not build the mint call")
        return
      }
    }
    writeContract({
      address: desc.address,
      abi: desc.abi,
      functionName: fn,
      args,
      value: total,
    })
  }

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
              {supplyText}
            </span>
          </div>

          {pct !== null && (
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-gray-100">
              <div className="h-full bg-fg transition-all" style={{ width: `${pct}%` }} />
            </div>
          )}

          <div className="flex items-end justify-between gap-6">
            <div className="space-y-1">
              <p className="text-[10px] font-mono uppercase tracking-wider text-gray-400">Price</p>
              <p className="text-2xl font-mono font-medium tabular-nums tracking-tight leading-none">
                {quoted && !quoteState.quote ? (
                  <span className="text-sm font-mono text-gray-500">
                    {quoteState.status === "error" ? "Quote unavailable" : "Fetching quote…"}
                  </span>
                ) : gasOnly ? (
                  <>
                    Gas only{" "}
                    <span className="text-sm font-mono text-gray-500">· you pay network gas</span>
                  </>
                ) : (
                  <>
                    {trimEth(formatEther(price))}{" "}
                    <span className="text-sm font-mono text-gray-500">ETH</span>
                  </>
                )}
              </p>
            </div>
            {countdownTo > 0n && countdownLabel && (
              <div className="text-right space-y-1">
                <p className="text-[10px] font-mono uppercase tracking-wider text-gray-400">
                  {countdownLabel}
                </p>
                <p className="text-sm font-mono tabular-nums leading-none">
                  <Countdown endTime={countdownTo} nowSec={nowSec} />
                </p>
              </div>
            )}
          </div>

          {/* Quote breakdown + manual refresh (2.2). */}
          {quoted && quoteState.quote && (
            <div className="space-y-1.5">
              {quoteState.quote.breakdown.map((line) => (
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
                  {quoteState.quote.note ?? ""}
                </span>
                <button
                  type="button"
                  onClick={quoteState.refresh}
                  className="text-[10px] font-mono uppercase tracking-wider text-gray-400 underline hover:text-fg"
                >
                  Refresh quote
                </button>
              </div>
            </div>
          )}
          {quoted && quoteState.status === "error" && (
            <p className="text-[11px] font-mono text-red-500 break-words">
              Quote failed: {quoteState.error}{" "}
              <button
                type="button"
                onClick={quoteState.refresh}
                className="underline hover:text-fg"
              >
                Retry
              </button>
            </p>
          )}

          {isSuccess && txHash && (
            <>
              <TxSuccessBanner
                txHash={txHash}
                chainId={PREFERRED_CHAIN.id}
                message={`Minted. Your ${noun} is yours onchain.`}
                onDismiss={() => {
                  reset()
                  setSelection(undefined)
                  router.refresh()
                }}
              />
              {/* Reveal step (2.4): link straight to the drawn token. */}
              {desc.reveal && revealedTokenId !== null && (
                <Link
                  href={`/mint/${collectionId}/${revealedTokenId.toString()}`}
                  className="block w-full text-center text-[11px] font-mono font-medium uppercase tracking-wider py-3 bg-fg text-bg hover:opacity-80 transition-colors"
                >
                  See your {noun} · #{revealedTokenId.toString()}
                </Link>
              )}
            </>
          )}

          {mintable && !(isSuccess && txHash) && (
            <>
              {/* Eligibility state (2.3): reason text, positive or negative. */}
              {eligibilityState.status === "checking" && (
                <p className="text-[11px] font-mono text-gray-500">Checking eligibility…</p>
              )}
              {eligibilityState.status === "error" && (
                <p className="text-[11px] font-mono text-red-500 break-words">
                  Eligibility check failed: {eligibilityState.error}{" "}
                  <button
                    type="button"
                    onClick={eligibilityState.refresh}
                    className="underline hover:text-fg"
                  >
                    Retry
                  </button>
                </p>
              )}
              {eligibilityState.status === "ready" && eligibilityState.result?.reason && (
                <p className="text-[11px] font-mono text-gray-500 leading-relaxed">
                  {eligibilityState.result.reason}
                </p>
              )}

              {/* Selector slot (Vouch: seat picker; later: a punk picker)
                  feeding `selection` into the args builder. */}
              {selectorKey && !ineligible && (
                <PhaseSelectorSlot
                  selectorKey={selectorKey}
                  phaseKey={activePhase?.key ?? null}
                  eligibilityData={eligibilityState.result?.data}
                  serverData={selectorData}
                  selection={selection}
                  onSelect={setSelection}
                  disabled={isPending}
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
                      value={amount}
                      onChange={(e) => {
                        const n = parseInt(e.target.value, 10)
                        setAmount(Number.isNaN(n) ? 0 : n)
                      }}
                      disabled={isPending}
                      className="flex-1 px-3 py-3 text-sm font-mono tabular-nums outline-none disabled:opacity-40"
                    />
                    <span className="flex items-center px-3 text-[11px] font-mono uppercase tracking-wider text-gray-400 border-l border-gray-200">
                      {amount === 1 ? desc.tokenNoun : `${desc.tokenNoun}s`}
                    </span>
                  </div>
                </label>
              )}

              {!gasOnly && !(quoted && !quoteState.quote) && (
                <div className="flex items-baseline justify-between">
                  <span className="text-[10px] font-mono uppercase tracking-wider text-gray-400">
                    You pay
                  </span>
                  <span className="text-sm font-mono tabular-nums">{trimEth(formatEther(total))} ETH</span>
                </div>
              )}

              {balance && (
                <div className="flex justify-end">
                  <span className="text-[10px] font-mono uppercase tracking-wider text-gray-400 tabular-nums">
                    Balance: {Number(formatEther(balance.value)).toFixed(3)} ETH
                  </span>
                </div>
              )}

              {!address ? (
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
              ) : wrongNetwork ? (
                <button
                  type="button"
                  onClick={() => switchChain({ chainId: PREFERRED_CHAIN.id })}
                  disabled={isSwitchPending}
                  className="block w-full text-center text-[11px] font-mono font-medium uppercase tracking-wider py-3 bg-fg text-bg hover:opacity-80 transition-colors disabled:opacity-40"
                >
                  {isSwitchPending ? "Switching…" : `Switch to ${PREFERRED_CHAIN_LABEL}`}
                </button>
              ) : (
                <button
                  onClick={() => void handleMint()}
                  disabled={
                    isPending ||
                    !amountValid ||
                    quoteBlocked ||
                    needsSelection ||
                    ineligible ||
                    eligibilityState.status === "checking" ||
                    eligibilityState.status === "error"
                  }
                  className="block w-full text-center text-[11px] font-mono font-medium uppercase tracking-wider py-3 bg-fg text-bg hover:opacity-80 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  {isWritePending
                    ? "Confirm in wallet…"
                    : isTxPending
                      ? "Minting…"
                      : needsSelection
                        ? `Pick a ${noun} to mint`
                        : gasOnly
                          ? "Mint (gas only)"
                          : quoted && !quoteState.quote
                            ? "Quote unavailable"
                            : `Mint for ${trimEth(formatEther(total))} ETH`}
                </button>
              )}

              {(writeError || buildError) && (
                <p className="text-[11px] font-mono text-red-500 break-words">
                  {buildError ?? formatWriteError(writeError, "Mint")}
                </p>
              )}
            </>
          )}

          {!mintable && !(isSuccess && txHash) && ready && (
            <p className="text-[11px] font-mono text-gray-500 leading-relaxed">
              {notStarted
                ? "This mint hasn't opened yet."
                : soldOut
                  ? desc.supplyLabel === "outstanding"
                    ? `Every ${desc.tokenNoun} is currently outstanding.`
                    : `Every ${desc.tokenNoun} has been minted.`
                  : alreadyMinted
                    ? `You already hold a ${desc.tokenNoun} from this collection (one per wallet).`
                    : phaseState && !phaseState.anyScheduled
                      ? "No mint window has been scheduled yet."
                      : "This mint is closed."}
            </p>
          )}
        </div>
      </div>
    </section>
  )
}
