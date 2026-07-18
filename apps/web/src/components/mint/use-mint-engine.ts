"use client"

/**
 * Headless mint engine for the `/mint/[contract]` surface — the state machine
 * extracted from MintPanel so one engine can drive two skins: the standard
 * panel (MintPanel.tsx) and curated layouts that restyle the same flow
 * (Homage's gallery register). All descriptor semantics live here — phase
 * resolution, provider keys, quote, eligibility, selection, args building,
 * write → receipt → reveal — the skins only render.
 *
 * `quoteEnabled: false` withholds the quote provider key from useMintQuote
 * (which treats a null key as "no dynamic pricing"), so a skin can stop quote
 * polling while it shows a reveal — the RPC-discipline pattern the Homage
 * site uses (quote paused pre-mint and while the reveal overlay is up).
 */

import { useMemo, useState } from "react"
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
import { PREFERRED_CHAIN, useChainNowSec } from "@/components/tx/tx-ui"
import { resolveMintCollection, type MintCollection, type MintPhase } from "@/lib/mint-collections"
import type { MintSnapshot } from "@/lib/mint-onchain"
import { resolvePhaseState, type PhaseState, type PhaseWindow } from "@/lib/mint-phases"
import { extractRevealTokenId } from "@/lib/mint-reveal"
import { getArgsBuilder } from "@/lib/mint-registries"
import { useMintQuote, usePhaseEligibility, type QuoteState, type EligibilityState } from "./mint-hooks"

export type MintEngine = {
  /** Null when the collectionId doesn't resolve — skins should render null. */
  desc: MintCollection | null
  // wallet / network
  address: `0x${string}` | undefined
  wrongNetwork: boolean
  switchChain: ReturnType<typeof useSwitchChain>["switchChain"]
  isSwitchPending: boolean
  balanceWei: bigint | null
  // clock + phases
  nowSec: number
  phaseWindows: PhaseWindow[] | null
  phaseState: PhaseState | null
  activePhase: MintPhase | null
  activeWindow: PhaseWindow | null
  // pricing
  quoted: boolean
  quoteState: QuoteState
  quoteBlocked: boolean
  price: bigint
  total: bigint
  gasOnly: boolean
  // eligibility + selection
  eligibilityState: EligibilityState
  ineligible: boolean
  selectorKey: string | null
  selection: unknown
  setSelection: (s: unknown) => void
  needsSelection: boolean
  // quantity mints
  amount: number
  setAmount: (n: number) => void
  qty: number
  amountValid: boolean
  // window / supply flags
  ready: boolean
  notStarted: boolean
  windowClosed: boolean
  minted: bigint
  cap: bigint
  remaining: bigint | null
  soldOut: boolean
  alreadyMinted: boolean
  mintable: boolean
  // presentation-ready derivations shared by both skins
  noun: string
  pct: number | null
  supplyText: string
  countdownTo: bigint
  countdownLabel: string
  // write flow
  mint: () => Promise<void>
  busy: "confirm" | "pending" | null
  isPending: boolean
  isSuccess: boolean
  txHash: `0x${string}` | undefined
  revealedTokenId: bigint | null
  buildError: string | null
  writeError: Error | null
  receiptError: Error | null
  /** Clears the write state + selection + build error (post-success reset). */
  reset: () => void
}

export function useMintEngine(
  collectionId: string,
  snapshot: MintSnapshot,
  opts?: { quoteEnabled?: boolean },
): MintEngine {
  const desc = resolveMintCollection(collectionId)
  const quoteEnabled = opts?.quoteEnabled ?? true
  const { address } = useAccount()
  const chainId = useChainId()
  const client = usePublicClient()
  const { switchChain, isPending: isSwitchPending } = useSwitchChain()
  const nowSec = useChainNowSec()
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
  const quoteState = useMintQuote(quoteEnabled ? quoteKey : null, activePhase?.key ?? null)

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
    reset: resetWrite,
  } = useWriteContract()
  // `error` here covers txs that landed but REVERTED onchain: wagmi's
  // waitForTransactionReceipt throws on a reverted receipt (most wallets
  // catch reverts at estimation time, but anvil impersonation — and a user
  // overriding their wallet's warning — mines them). Without surfacing it
  // the panel would sit silent after a failed mint.
  // retry: false — the only way this query FAILS is wagmi's throw on a
  // receipt whose tx REVERTED onchain, which is terminal (the mined status
  // never changes); retrying just re-fetches the same receipt three times
  // and delays the error surfacing by ~10s. Transient RPC errors during the
  // wait are already retried inside viem's poll loop + http transport.
  const {
    isLoading: isTxPending,
    isSuccess,
    data: receipt,
    error: receiptError,
  } = useWaitForTransactionReceipt({ hash: txHash, query: { retry: false } })
  const isPending = isWritePending || isTxPending

  // ── post-mint reveal (2.4) — pure parse of the already-fetched receipt ────
  // The Transfer/announce log the reveal watches is emitted by the TOKEN
  // contract — Homage's separate pooled collection, not the mint engine
  // `desc.address` resolves to (which has no ERC-721 surface at all).
  // `tokenContract` falls back to `{ address, abi }` for single-contract
  // collections (Vouch), so this is a no-op there.
  const tokenAddress = desc?.tokenContract?.address ?? desc?.address
  const tokenAbi = desc?.tokenContract?.abi ?? desc?.abi
  const revealedTokenId = useMemo(() => {
    if (!desc?.reveal || !isSuccess || !receipt || !tokenAddress || !tokenAbi) return null
    return extractRevealTokenId({
      reveal: desc.reveal,
      logs: receipt.logs,
      collection: tokenAddress,
      abi: tokenAbi,
      minter: address,
    })
  }, [desc?.reveal, tokenAddress, tokenAbi, isSuccess, receipt, address])

  const quoted = quoteKey !== null
  const price = quoted && quoteState.quote ? quoteState.quote.value : BigInt(snapshot.priceWei)
  const minted = BigInt(snapshot.minted)
  const cap = BigInt(snapshot.cap)
  const mintStart = BigInt(snapshot.mintStart)
  const mintEnd = BigInt(snapshot.mintEnd)
  const gasOnly = !quoted && price === 0n

  const qty = desc?.quantity ? amount : 1
  const amountValid = !desc?.quantity || (Number.isInteger(amount) && amount >= 1)
  const total = desc?.quantity ? price * BigInt(qty) : price

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
  const alreadyMinted = !!desc?.alreadyMintedFn && alreadyMintedRaw === true
  const ineligible =
    eligibilityState.status === "ready" && eligibilityState.result?.eligible === false
  const mintable =
    ready && !notStarted && !windowClosed && !soldOut && !alreadyMinted && (!phaseState || !!activePhase)

  const noun = activePhase?.noun ?? desc?.tokenNoun ?? "token"
  const pct = cap > 0n ? Math.min(100, Math.round((Number(minted) / Number(cap)) * 100)) : null
  const supplyText =
    cap > 0n
      ? desc?.supplyLabel === "outstanding"
        ? `${Number(minted)} of ${Number(cap)} outstanding`
        : `${Number(minted)} / ${Number(cap)} minted`
      : desc?.supplyLabel === "outstanding"
        ? `${Number(minted)} outstanding`
        : `${Number(minted)} minted`

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

  async function mint() {
    if (!desc || !amountValid || !mintable) return
    setBuildError(null)
    let fn = activePhase?.mintFn ?? desc.mintFn
    let args: unknown[] = desc.quantity ? [BigInt(qty)] : []
    if (argsBuilderKey) {
      const builder = getArgsBuilder(argsBuilderKey)
      if (!builder || !client) {
        setBuildError(`Args builder "${argsBuilderKey}" is not registered`)
        return
      }
      try {
        const built = await builder({
          client,
          wallet: address,
          phaseKey: activePhase?.key ?? null,
          selection,
          eligibilityData: eligibilityState.result?.data,
        })
        // Bare args keep the phase/descriptor mintFn; a BuiltCall may override
        // it (Homage claim routing: claim / claimFor / claimTo by selection).
        if (Array.isArray(built)) {
          args = built
        } else {
          args = built.args
          if (built.fn) fn = built.fn
        }
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

  function reset() {
    resetWrite()
    setSelection(undefined)
    setBuildError(null)
  }

  return {
    desc,
    address,
    wrongNetwork,
    switchChain,
    isSwitchPending,
    balanceWei: balance ? balance.value : null,
    nowSec,
    phaseWindows,
    phaseState,
    activePhase,
    activeWindow,
    quoted,
    quoteState,
    quoteBlocked,
    price,
    total,
    gasOnly,
    eligibilityState,
    ineligible,
    selectorKey,
    selection,
    setSelection,
    needsSelection,
    amount,
    setAmount,
    qty,
    amountValid,
    ready,
    notStarted,
    windowClosed,
    minted,
    cap,
    remaining,
    soldOut,
    alreadyMinted,
    mintable,
    noun,
    pct,
    supplyText,
    countdownTo,
    countdownLabel,
    mint,
    busy: isWritePending ? "confirm" : isTxPending ? "pending" : null,
    isPending,
    isSuccess,
    txHash,
    revealedTokenId,
    buildError,
    writeError: writeError ?? null,
    receiptError: receiptError ?? null,
    reset,
  }
}
