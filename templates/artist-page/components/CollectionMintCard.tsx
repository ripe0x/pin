"use client"

import { useEffect, useMemo, useState } from "react"
import { useRouter } from "next/navigation"
import { useQuery } from "@tanstack/react-query"
import { type Address, formatEther } from "viem"
import {
  useAccount,
  useBalance,
  usePublicClient,
  useSwitchChain,
  useWaitForTransactionReceipt,
  useWriteContract,
} from "wagmi"
import { ConnectButton as RKConnectButton } from "@rainbow-me/rainbowkit"
import { formatAddress, formatTimeRemaining } from "@/lib/format"
import {
  MINT_CHAIN_ID,
  buildMintRequest,
  describeMintError,
} from "@/lib/mint-transaction"
import {
  deserializeCollection,
  pndCollectionUrl,
  remainingSupply,
  salePhase,
  ZERO_ADDRESS,
  type CollectionSummary,
  type SaleState,
  type SalePhase,
  type SerializedCollectionSummary,
} from "@/lib/surface"
import { quoteMint, readCollectionSummary, readMintedBy } from "@/lib/surface-reads"

type Props = {
  collectionAddress: Address
  /**
   * The address credited the sale's referral share for mints from this
   * page, already resolved server-side (lib/surface.ts resolveReferrer):
   * NEXT_PUBLIC_MINT_REFERRER, else the collection owner, else the artist.
   * On the artist's own site the referral share lands back with the artist.
   */
  referrer: Address
  /** Server-rendered snapshot for first paint (bigints as strings). */
  initial: SerializedCollectionSummary
}

/** Per-transaction quantity ceiling when no cap is tighter. */
const MAX_QUANTITY = 20n

const PHASE_LABEL: Record<SalePhase, string> = {
  "not-started": "Not open yet",
  open: "Open",
  ended: "Ended",
  closed: "Closed",
  "sold-out": "Sold out",
}

/**
 * Mint card for the artist's optional Surface collection (v1 or v2). Mirrors
 * BidForm's chrome (status dot + big tabular-nums price + one primary
 * action) so it reads as part of the same family as the auction panel.
 *
 * Read discipline: one live refresh of the collection + sale every 12s while
 * the tab is visible (two multicalls, see lib/surface-reads.ts), one
 * mintedBy read per connected wallet when a wallet cap is set, and the
 * mint-time priceOf + simulate only on click.
 *
 * Only rendered when `NEXT_PUBLIC_COLLECTION_ADDRESS` is configured.
 */
export function CollectionMintCard({ collectionAddress, referrer, initial }: Props) {
  const publicClient = usePublicClient({ chainId: MINT_CHAIN_ID })
  const initialSummary = useMemo(() => deserializeCollection(initial), [initial])

  // No `initialData` seeding, same reasoning as BidForm: a server snapshot
  // treated as fresh data can stick past a mint that happened after the
  // last ISR revalidation. The live read is the source of truth; `initial`
  // only covers the gap until it resolves.
  const live = useQuery({
    queryKey: ["surface-collection", collectionAddress],
    queryFn: () => readCollectionSummary(publicClient!, collectionAddress),
    enabled: Boolean(publicClient),
    refetchInterval: 12_000,
    staleTime: 10_000,
  })
  const c = live.data ?? initialSummary

  if (!c.sale) return <NoSale collection={c} />
  if (c.sale.gated) return <GatedSale collection={c} />
  return (
    <SaleCard
      collection={c}
      sale={c.sale}
      referrer={referrer}
      onMinted={() => live.refetch()}
    />
  )
}

function SaleCard({
  collection: c,
  sale,
  referrer,
  onMinted,
}: {
  collection: CollectionSummary
  sale: SaleState
  referrer: Address
  onMinted: () => void
}) {
  const router = useRouter()
  const publicClient = usePublicClient({ chainId: MINT_CHAIN_ID })
  const { address: connected, isConnected, chainId } = useAccount()
  const { switchChain, isPending: switching } = useSwitchChain()
  const wrongNetwork = isConnected && chainId !== MINT_CHAIN_ID

  const nowSec = useNowSec()
  const phase = salePhase(c, sale, nowSec)
  const remaining = remainingSupply(c, sale)

  // Wallet cap: the sale's own mintedBy counter, one read per wallet.
  const mintedBy = useQuery({
    queryKey: ["surface-minted-by", sale.address, connected],
    queryFn: () => readMintedBy(publicClient!, sale, connected!),
    enabled: Boolean(publicClient && connected && sale.walletCap > 0n),
    staleTime: 15_000,
  })
  const walletLeft =
    sale.walletCap > 0n && mintedBy.data !== undefined
      ? sale.walletCap - mintedBy.data
      : null

  let maxQty = MAX_QUANTITY
  if (remaining !== null && remaining < maxQty) maxQty = remaining
  if (walletLeft !== null && walletLeft < maxQty) maxQty = walletLeft
  if (maxQty < 0n) maxQty = 0n

  const [qty, setQty] = useState(1n)
  useEffect(() => {
    if (maxQty > 0n && qty > maxQty) setQty(maxQty)
  }, [maxQty, qty])

  const unitPrice = sale.quote1
  const total = unitPrice * qty

  const balanceQuery = useBalance({
    address: connected,
    chainId: MINT_CHAIN_ID,
    query: { enabled: Boolean(connected) && !wrongNetwork, refetchInterval: 12_000 },
  })
  const balanceWei = balanceQuery.data?.value ?? 0n
  const insufficient = balanceQuery.isSuccess && total > balanceWei

  const { writeContract, data: txHash, isPending, error: writeError, reset } =
    useWriteContract()
  const { isLoading: confirming, isSuccess: confirmed } =
    useWaitForTransactionReceipt({ hash: txHash, chainId: MINT_CHAIN_ID })
  const [simulating, setSimulating] = useState(false)
  const [simError, setSimError] = useState<string | null>(null)

  useEffect(() => {
    if (!confirmed) return
    onMinted()
    mintedBy.refetch()
    // The recent-mints grid is server-rendered; pick up the new token once
    // the server cache turns over.
    router.refresh()
  }, [confirmed]) // eslint-disable-line react-hooks/exhaustive-deps

  async function submit() {
    if (!publicClient || !connected || qty < 1n) return
    reset()
    setSimError(null)
    setSimulating(true)
    try {
      // Price is read from the sale at click time, never from the cached
      // display value: both sales require exact payment for a fixed price.
      const value = await quoteMint(publicClient, sale, connected, qty)
      const request = buildMintRequest({
        sale,
        to: connected,
        quantity: qty,
        referrer,
        value,
      })
      // Simulate before asking the wallet to send value: a doomed mint
      // (window, caps, gate, price) fails here with a decoded reason instead
      // of costing the collector gas.
      // (Two branches only so each call narrows to one sale ABI; chainId
      // rides on the write, the public client is already pinned to it.)
      if (request.functionName === "mintWithReferral") {
        const { address, abi, functionName, args, value: v } = request
        await publicClient.simulateContract({ account: connected, address, abi, functionName, args, value: v })
        writeContract(request)
      } else {
        const { address, abi, functionName, args, value: v } = request
        await publicClient.simulateContract({ account: connected, address, abi, functionName, args, value: v })
        writeContract(request)
      }
    } catch (err) {
      setSimError(describeMintError(err))
    } finally {
      setSimulating(false)
    }
  }

  const mintable = phase === "open" && maxQty > 0n
  const statusDot =
    phase === "open" ? "bg-status-live animate-pulse" : phase === "not-started" ? "bg-status-upcoming" : "bg-gray-400"
  const errorText = simError ?? (writeError ? describeMintError(writeError) : null)

  return (
    <div className="rounded-lg border border-gray-200 bg-surface overflow-hidden">
      <div className="p-5 space-y-5">
        <div className="flex items-center justify-between gap-6">
          <div className="flex items-center gap-2">
            <span className={`inline-block h-1.5 w-1.5 rounded-full ${statusDot}`} />
            <span className="text-[10px] font-mono uppercase tracking-wider text-gray-500">
              {PHASE_LABEL[phase]}
              {phase === "not-started"
                ? ` · opens in ${formatTimeRemaining(Number(sale.mintStart) - nowSec)}`
                : ""}
            </span>
          </div>
          <div className="text-right">
            <p className="text-[10px] font-mono uppercase tracking-wider text-gray-400">Minted</p>
            <p className="text-sm font-mono tabular-nums leading-none text-gray-500">
              {c.minted.toString()}
              {c.supplyCap > 0n ? ` / ${c.supplyCap.toString()}` : ""}
            </p>
          </div>
        </div>

        <PriceRow unitPrice={unitPrice} strategy={sale.priceStrategy !== null} />

        {mintable ? (
          <QuantityRow qty={qty} max={maxQty} onChange={setQty} total={total} />
        ) : null}

        {!isConnected || !connected ? (
          <RKConnectButton.Custom>
            {({ openConnectModal }) => (
              <button type="button" onClick={openConnectModal} className={BUTTON}>
                Connect wallet to mint
              </button>
            )}
          </RKConnectButton.Custom>
        ) : wrongNetwork ? (
          <button
            type="button"
            onClick={() => switchChain({ chainId: MINT_CHAIN_ID })}
            disabled={switching}
            className={BUTTON}
          >
            {switching ? "Switching…" : "Switch to Ethereum to mint"}
          </button>
        ) : (
          <button
            type="button"
            onClick={submit}
            disabled={!mintable || simulating || isPending || confirming || insufficient}
            className={BUTTON}
          >
            {confirming
              ? "Waiting for confirmation…"
              : isPending
                ? "Confirm in wallet…"
                : simulating
                  ? "Checking…"
                  : !mintable
                    ? walletLeft !== null && walletLeft <= 0n && phase === "open"
                      ? "Wallet limit reached"
                      : PHASE_LABEL[phase]
                    : insufficient
                      ? `Insufficient balance · ${trimEth(formatEther(balanceWei))} ETH available`
                      : qty > 1n
                        ? `Mint ${qty.toString()}`
                        : "Mint"}
          </button>
        )}

        {confirmed ? (
          <p className="text-[11px] font-mono text-gray-500" role="status">
            Minted. It will appear below shortly.
          </p>
        ) : null}
        {errorText ? (
          <p className="text-[11px] font-mono text-status-sold" role="alert">
            {errorText}
          </p>
        ) : null}

        <ReferralNote sale={sale} referrer={referrer} unitPrice={unitPrice} />
      </div>
    </div>
  )
}

const BUTTON =
  "block w-full text-center text-[11px] font-mono font-medium uppercase tracking-wider py-3 bg-fg text-bg disabled:cursor-not-allowed disabled:opacity-60 hover:opacity-80 transition-opacity"

function PriceRow({ unitPrice, strategy }: { unitPrice: bigint; strategy: boolean }) {
  return (
    <div className="space-y-1">
      <p className="text-[10px] font-mono uppercase tracking-wider text-gray-400">
        {strategy ? "Current price" : "Price"}
      </p>
      <p className="text-2xl font-mono font-medium tabular-nums tracking-tight leading-none">
        {unitPrice === 0n ? (
          "Gas only"
        ) : (
          <>
            {trimEth(formatEther(unitPrice))}{" "}
            <span className="text-sm font-mono text-gray-500">ETH</span>
          </>
        )}
      </p>
    </div>
  )
}

function QuantityRow({
  qty,
  max,
  onChange,
  total,
}: {
  qty: bigint
  max: bigint
  onChange: (q: bigint) => void
  total: bigint
}) {
  if (max <= 1n) return null
  const step = "h-8 w-8 border border-gray-200 font-mono text-sm disabled:opacity-40"
  return (
    <div className="flex items-center justify-between gap-4">
      <div className="flex items-center gap-2">
        <button
          type="button"
          className={step}
          onClick={() => onChange(qty - 1n)}
          disabled={qty <= 1n}
          aria-label="One fewer"
        >
          −
        </button>
        <span className="w-8 text-center font-mono tabular-nums text-sm">{qty.toString()}</span>
        <button
          type="button"
          className={step}
          onClick={() => onChange(qty + 1n)}
          disabled={qty >= max}
          aria-label="One more"
        >
          +
        </button>
      </div>
      {total > 0n ? (
        <p className="text-[11px] font-mono tabular-nums text-gray-500">
          Total {trimEth(formatEther(total))} ETH
        </p>
      ) : null}
    </div>
  )
}

function ReferralNote({
  sale,
  referrer,
  unitPrice,
}: {
  sale: SaleState
  referrer: Address
  unitPrice: bigint
}) {
  if (unitPrice === 0n) return null
  const pct = `${(sale.referralShareBps / 100).toString()}%`
  const noReferrer = referrer.toLowerCase() === ZERO_ADDRESS
  const toPayout = referrer.toLowerCase() === sale.payoutRecipient.toLowerCase()
  return (
    <p className="text-[10px] font-mono leading-relaxed text-gray-400">
      {noReferrer
        ? "Minted here with no referrer: the full price goes to the artist's payout address."
        : toPayout
          ? `Minted here, the ${pct} referral share goes to the artist's own payout address, so the artist keeps the full price.`
          : `Minted here, ${pct} of the price is credited as referral to ${formatAddress(referrer)}; the rest goes to the artist's payout address.`}
    </p>
  )
}

function NoSale({ collection: c }: { collection: CollectionSummary }) {
  const message =
    c.protocolVersion === 0
      ? "This collection is not a Surface collection this page can mint from."
      : c.minter === null
        ? "No sale is set up for this collection right now."
        : "This collection mints through its own minter contract, not a standard PND sale."
  return (
    <Notice>
      <p>{message}</p>
      {c.protocolVersion !== 0 && c.minter !== null ? (
        <PndLink collection={c.address} label="View it on pnd.fyi" />
      ) : null}
    </Notice>
  )
}

/**
 * Allowlist minting needs a Merkle proof for the collector's wallet, built
 * from the published list. That list lives with PND (its allowlist API is
 * same-origin only), and this template runs no backend that could hold it,
 * so a gated sale links out instead of minting here.
 */
function GatedSale({ collection: c }: { collection: CollectionSummary }) {
  return (
    <Notice>
      <p>Allowlist mint — use the collection page on pnd.fyi.</p>
      <PndLink collection={c.address} label="Mint on pnd.fyi" />
    </Notice>
  )
}

function Notice({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-gray-200 bg-surface p-5 space-y-3 text-[11px] font-mono text-gray-500 leading-relaxed">
      {children}
    </div>
  )
}

function PndLink({ collection, label }: { collection: Address; label: string }) {
  return (
    <a
      href={pndCollectionUrl(collection)}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-block underline underline-offset-2 hover:text-fg"
    >
      {label} ↗
    </a>
  )
}

function trimEth(s: string): string {
  if (!s.includes(".")) return s
  return s.replace(/\.?0+$/, "")
}

function useNowSec(): number {
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000))
  useEffect(() => {
    const id = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000)
    return () => clearInterval(id)
  }, [])
  return now
}
