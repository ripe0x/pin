"use client"

/**
 * The artist flow, one step: configure an edition and deploy it. Deploying an
 * edition mints you your own ERC721A contract, set up with your artwork and
 * mint conditions in a single transaction. Crypto-native: wallet-first,
 * decoded, honest pricing language.
 */

import { useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import { isAddress, parseEventLogs, type Address } from "viem"
import {
  useAccount,
  useChainId,
  useSwitchChain,
  useWaitForTransactionReceipt,
  useWriteContract,
} from "wagmi"
import { ConnectButton } from "@rainbow-me/rainbowkit"
import { pndEditionsFactoryAbi } from "@pin/abi"
import { OptimizedImage } from "@/components/OptimizedImage"
import { PREFERRED_CHAIN, PREFERRED_CHAIN_LABEL, formatWriteError } from "@/components/tx/tx-ui"
import { useEthAmountInput } from "@/lib/useEthAmountInput"
import {
  EditionKind,
  SURFACE_SHARE_BPS,
  ZERO_ADDRESS,
  formatBps,
  pndEditionsFactory,
} from "@/lib/pnd-editions"

const LABEL = "block text-[10px] font-mono uppercase tracking-wider text-gray-400 mb-1.5"
const INPUT =
  "w-full px-3 py-2 text-xs font-mono bg-surface border border-gray-200 focus:border-gray-400 outline-none transition-colors disabled:opacity-40"
const BTN =
  "block w-full text-center text-[11px] font-mono font-medium uppercase tracking-wider py-3 bg-fg text-bg hover:opacity-80 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
const HELP = "mt-1.5 text-[10px] font-mono text-gray-400 leading-relaxed"

export function CreateEditionForm() {
  const { address } = useAccount()
  const chainId = useChainId()
  const { switchChain, isPending: isSwitchPending } = useSwitchChain()
  const wrongNetwork = !!address && chainId !== PREFERRED_CHAIN.id
  const router = useRouter()

  const factory = pndEditionsFactory()

  const [title, setTitle] = useState("")
  const [symbol, setSymbol] = useState("")
  const [artworkURI, setArtworkURI] = useState("")
  const price = useEthAmountInput()
  const [openEdition, setOpenEdition] = useState(true)
  const [supplyCap, setSupplyCap] = useState("100")
  const [hasWindow, setHasWindow] = useState(false)
  const [startAt, setStartAt] = useState("")
  const [endAt, setEndAt] = useState("")
  const [royaltyPct, setRoyaltyPct] = useState("10")
  const [payout, setPayout] = useState("")

  const { writeContract, data: txHash, isPending, error, reset } = useWriteContract()
  const { data: receipt, isLoading: mining } = useWaitForTransactionReceipt({ hash: txHash })

  useEffect(() => {
    if (!receipt || !txHash) return
    try {
      const logs = parseEventLogs({
        abi: pndEditionsFactoryAbi,
        logs: receipt.logs,
        eventName: "EditionCreated",
      })
      const created = logs[0]?.args as { edition?: Address } | undefined
      if (created?.edition) {
        reset()
        router.push(`/editions/${created.edition}`)
      }
    } catch {
      // fall through; user can retry
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [receipt, txHash])

  if (!address) {
    return (
      <Shell>
        <ConnectButton.Custom>
          {({ openConnectModal }) => (
            <button onClick={openConnectModal} className={BTN}>
              Connect wallet to start
            </button>
          )}
        </ConnectButton.Custom>
      </Shell>
    )
  }

  if (wrongNetwork) {
    return (
      <Shell>
        <button
          onClick={() => switchChain({ chainId: PREFERRED_CHAIN.id })}
          disabled={isSwitchPending}
          className={BTN}
        >
          {isSwitchPending ? "Switching…" : `Switch to ${PREFERRED_CHAIN_LABEL}`}
        </button>
      </Shell>
    )
  }

  const royaltyBps = Math.round(Number(royaltyPct || "0") * 100)
  const royaltyOk = royaltyBps >= 0 && royaltyBps <= 10_000
  const capOk = openEdition || (Number(supplyCap) > 0 && Number.isFinite(Number(supplyCap)))
  const payoutOk = payout === "" || isAddress(payout)
  const canSubmit =
    !!factory &&
    !!address &&
    title.trim().length > 0 &&
    symbol.trim().length > 0 &&
    artworkURI.trim().length > 0 &&
    (price.isEmpty || price.isValid) &&
    royaltyOk &&
    capOk &&
    payoutOk

  function toUnix(local: string): bigint {
    if (!local) return 0n
    const ms = new Date(local).getTime()
    return Number.isNaN(ms) ? 0n : BigInt(Math.floor(ms / 1000))
  }

  function submit() {
    if (!canSubmit || !factory || !address) return
    const cfg = {
      artworkURI: artworkURI.trim(),
      price: price.wei ?? 0n,
      supplyCap: openEdition ? 0n : BigInt(Math.floor(Number(supplyCap))),
      mintStart: hasWindow ? toUnix(startAt) : 0n,
      mintEnd: hasWindow ? toUnix(endAt) : 0n,
      royaltyBps,
      royaltyReceiver: ZERO_ADDRESS as Address,
      kind: EditionKind.Standalone,
      payoutAddress: (payout === "" ? ZERO_ADDRESS : payout) as Address,
      renderer: ZERO_ADDRESS as Address,
      mintHook: ZERO_ADDRESS as Address,
    }
    writeContract({
      address: factory,
      abi: pndEditionsFactoryAbi,
      functionName: "createEdition",
      args: [title.trim(), symbol.trim(), address, cfg],
    })
  }

  const busy = isPending || mining

  return (
    <div className="rounded-lg border border-gray-200 bg-surface p-5 space-y-5">
      {!factory && (
        <p className="text-[11px] font-mono text-red-500">
          No PND Editions factory is configured for this network.
        </p>
      )}

      <div className="grid grid-cols-3 gap-3">
        <div className="col-span-2">
          <label className={LABEL} htmlFor="ed-title">
            Title
          </label>
          <input
            id="ed-title"
            className={INPUT}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Studies in Grey"
            disabled={busy}
          />
        </div>
        <div>
          <label className={LABEL} htmlFor="ed-symbol">
            Symbol
          </label>
          <input
            id="ed-symbol"
            className={INPUT}
            value={symbol}
            onChange={(e) => setSymbol(e.target.value.toUpperCase())}
            placeholder="GREY"
            disabled={busy}
          />
        </div>
      </div>

      <div>
        <label className={LABEL} htmlFor="ed-art">
          Artwork URI
        </label>
        <input
          id="ed-art"
          className={INPUT}
          value={artworkURI}
          onChange={(e) => setArtworkURI(e.target.value.trim())}
          placeholder="ipfs://…"
          disabled={busy}
        />
        <p className={HELP}>
          The shared art for this edition. ipfs:// recommended. Tokens can carry
          unique art later. PND can pin it via Preserve.
        </p>
        {artworkURI.startsWith("ipfs://") || artworkURI.startsWith("https://") ? (
          <div className="mt-3 aspect-square w-28 overflow-hidden rounded border border-gray-200 bg-surface-muted">
            <OptimizedImage
              src={artworkURI}
              alt="Artwork preview"
              width={224}
              className="h-full w-full object-cover"
            />
          </div>
        ) : null}
      </div>

      <div>
        <label className={LABEL} htmlFor="ed-price">
          Price (ETH)
        </label>
        <input
          id="ed-price"
          {...price.inputProps}
          placeholder="0"
          className={INPUT}
          disabled={busy}
        />
        <p className={HELP}>
          0 = gas only (never called free). On paid mints, a fixed{" "}
          {formatBps(SURFACE_SHARE_BPS)} surface share goes to PND when minted here. Deploy
          your own site and you keep it.
        </p>
        {price.error && <p className="mt-1 text-[10px] font-mono text-red-500">{price.error}</p>}
      </div>

      <div>
        <label className="flex items-center gap-2 mb-2">
          <input
            type="checkbox"
            checked={openEdition}
            onChange={(e) => setOpenEdition(e.target.checked)}
            disabled={busy}
          />
          <span className="text-[11px] font-mono text-gray-600">Open edition (no cap)</span>
        </label>
        {!openEdition && (
          <input
            type="number"
            min={1}
            step={1}
            className={INPUT}
            value={supplyCap}
            onChange={(e) => setSupplyCap(e.target.value)}
            disabled={busy}
            placeholder="Max supply"
          />
        )}
      </div>

      <div>
        <label className="flex items-center gap-2 mb-2">
          <input
            type="checkbox"
            checked={hasWindow}
            onChange={(e) => setHasWindow(e.target.checked)}
            disabled={busy}
          />
          <span className="text-[11px] font-mono text-gray-600">Set a mint window</span>
        </label>
        {hasWindow && (
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={LABEL} htmlFor="ed-start">
                Opens
              </label>
              <input
                id="ed-start"
                type="datetime-local"
                className={INPUT}
                value={startAt}
                onChange={(e) => setStartAt(e.target.value)}
                disabled={busy}
              />
            </div>
            <div>
              <label className={LABEL} htmlFor="ed-end">
                Closes
              </label>
              <input
                id="ed-end"
                type="datetime-local"
                className={INPUT}
                value={endAt}
                onChange={(e) => setEndAt(e.target.value)}
                disabled={busy}
              />
            </div>
          </div>
        )}
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className={LABEL} htmlFor="ed-royalty">
            Royalty (%)
          </label>
          <input
            id="ed-royalty"
            type="text"
            inputMode="decimal"
            className={INPUT}
            value={royaltyPct}
            onChange={(e) => setRoyaltyPct(e.target.value.replace(/[^0-9.]/g, ""))}
            disabled={busy}
          />
          <p className={HELP}>EIP-2981, honored by marketplaces.</p>
        </div>
        <div>
          <label className={LABEL} htmlFor="ed-payout">
            Payout (optional)
          </label>
          <input
            id="ed-payout"
            className={INPUT}
            value={payout}
            onChange={(e) => setPayout(e.target.value.trim())}
            placeholder="defaults to you"
            disabled={busy}
          />
          {!payoutOk && <p className="mt-1 text-[10px] font-mono text-red-500">Invalid address</p>}
        </div>
      </div>

      <button onClick={submit} disabled={!canSubmit || busy} className={BTN}>
        {isPending ? "Confirm in wallet…" : mining ? "Deploying edition…" : "Deploy edition"}
      </button>

      {error && (
        <p className="text-[11px] font-mono text-red-500 break-words">
          {formatWriteError(error, "Deploy")}
        </p>
      )}
    </div>
  )
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-gray-200 bg-surface p-5 space-y-4">
      <p className="text-[11px] font-mono text-gray-500 leading-relaxed">
        Deploying an edition mints you your own ERC721A contract, set up with your
        artwork and mint conditions in one transaction. You own it. Each token a
        collector mints keeps its own identity and onchain Mint Mark.
      </p>
      {children}
    </div>
  )
}
