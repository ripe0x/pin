"use client"

import { useEffect, useState } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { ConnectButton } from "@rainbow-me/rainbowkit"
import { useAccount } from "wagmi"
import { BulkDelistPanel } from "@/components/listings/BulkDelistPanel"
import { SellerListingsView } from "@/components/listings/SellerListingsView"
import { useSellerListings } from "@/lib/useSellerListings"

export function DelistClient({
  initialAddress,
  initialInput,
}: {
  initialAddress: string | null
  initialInput: string
}) {
  const router = useRouter()
  const { address: connectedAddress } = useAccount()
  const [input, setInput] = useState(initialInput)
  const [error, setError] = useState("")

  // Auto-populate the URL with the connected wallet once it connects, but
  // only when no address is in the URL yet — don't clobber a shared
  // `?address=` link if a different wallet happens to be connected.
  useEffect(() => {
    if (!connectedAddress) return
    if (initialAddress) return
    router.replace(`/delist?address=${connectedAddress}`)
  }, [connectedAddress, initialAddress, router])

  function onSubmit(e: React.FormEvent) {
    e.preventDefault()
    const trimmed = input.trim()
    if (!trimmed) {
      setError("Enter an address or ENS name.")
      return
    }
    setError("")
    router.push(`/delist?address=${encodeURIComponent(trimmed)}`)
  }

  // Three render states:
  //   1. No resolved address: hero + form.
  //   2. Address resolved but visitor isn't the owner: read-only preview.
  //   3. Address resolved AND matches connected wallet: full interactive
  //      delist panel (same component used on /artist/[address]).
  if (!initialAddress) {
    return (
      <PageShell>
        <Hero />
        <AddressInputForm
          input={input}
          setInput={setInput}
          onSubmit={onSubmit}
          error={error}
          invalidEns={initialInput.length > 0 && !initialAddress}
        />
      </PageShell>
    )
  }

  const isOwner =
    !!connectedAddress &&
    connectedAddress.toLowerCase() === initialAddress.toLowerCase()

  return (
    <PageShell>
      <Hero />
      <AddressInputForm
        input={input}
        setInput={setInput}
        onSubmit={onSubmit}
        error={error}
        invalidEns={false}
      />

      {isOwner ? (
        <BulkDelistPanel artistAddress={initialAddress} />
      ) : (
        <ReadOnlyPreview
          address={initialAddress}
          connectedAddress={connectedAddress}
        />
      )}
    </PageShell>
  )
}

function PageShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="mx-auto max-w-2xl px-6 py-12 space-y-8">{children}</div>
  )
}

function Hero() {
  return (
    <header className="space-y-4">
      <h1 className="text-3xl font-semibold tracking-tight">
        Delist from platforms
      </h1>
      <p className="text-base text-fg-muted leading-relaxed">
        If you&rsquo;re done selling on Foundation or SuperRare, your
        listings stay live there until you cancel each one. This tool
        cancels them all in a single transaction, straight against the
        marketplace contracts. Gas only, no fees, nothing routes through
        this site.
      </p>
      <p className="text-base text-fg-muted leading-relaxed">
        Paste any address or ENS to see what&rsquo;s still listed.
        Connect that wallet to take it down.
      </p>
    </header>
  )
}

function AddressInputForm({
  input,
  setInput,
  onSubmit,
  error,
  invalidEns,
}: {
  input: string
  setInput: (v: string) => void
  onSubmit: (e: React.FormEvent) => void
  error: string
  invalidEns: boolean
}) {
  return (
    <form onSubmit={onSubmit} className="space-y-3">
      <div className="flex gap-2">
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="0x... or name.eth"
          className="flex-1 border border-gray-200 rounded-lg px-4 py-3 text-sm font-mono focus:outline-none focus:border-fg transition-colors"
        />
        <button
          type="submit"
          className="bg-fg text-bg px-5 py-3 rounded-lg text-sm font-medium hover:opacity-80 transition-colors"
        >
          Preview
        </button>
      </div>
      {error && <p className="text-sm text-red-500">{error}</p>}
      {invalidEns && (
        <p className="text-sm text-red-500">
          Could not resolve that name. Try a full 0x address.
        </p>
      )}
      <div className="flex items-center gap-3 text-sm text-gray-500">
        <span>or</span>
        <ConnectButton.Custom>
          {({ openConnectModal, account, mounted }) => {
            if (!mounted) return null
            if (account) {
              return (
                <span className="text-xs text-gray-400">
                  Connected as {account.displayName}
                </span>
              )
            }
            return (
              <button
                type="button"
                onClick={openConnectModal}
                className="text-sm font-medium underline hover:text-fg transition-colors"
              >
                Connect your wallet
              </button>
            )
          }}
        </ConnectButton.Custom>
      </div>
    </form>
  )
}

function ReadOnlyPreview({
  address,
  connectedAddress,
}: {
  address: string
  connectedAddress: string | undefined
}) {
  const { state, refresh } = useSellerListings(address)

  if (state.kind === "idle" || state.kind === "loading") {
    return (
      <Section>
        <p className="text-sm text-gray-500">Loading listings for {short(address)}…</p>
      </Section>
    )
  }
  if (state.kind === "error") {
    return (
      <Section>
        <p className="text-sm text-red-500">{state.message}</p>
        <button
          onClick={refresh}
          className="mt-3 text-xs font-medium underline text-gray-700 hover:text-fg"
        >
          Try again
        </button>
      </Section>
    )
  }

  const total = state.auctions.length + state.buyNows.length

  if (total === 0) {
    return (
      <Section>
        <header className="flex items-start gap-3">
          <CheckBadge />
          <div>
            <h2 className="text-sm font-semibold text-gray-900">
              Nothing to cancel
            </h2>
            <p className="mt-1 text-sm text-gray-500">
              {short(address)} has no active listings on Foundation or
              SuperRare right now.
            </p>
            <p className="mt-3 text-xs text-gray-400">
              View this wallet&rsquo;s work on{" "}
              <Link
                href={`/artist/${address}`}
                className="underline hover:text-fg"
              >
                their artist page
              </Link>
              .
            </p>
          </div>
        </header>
      </Section>
    )
  }

  return (
    <Section>
      <header className="mb-4 space-y-1">
        <h2 className="text-sm font-semibold text-gray-900">
          {total} active {total === 1 ? "listing" : "listings"}
        </h2>
        <p className="text-xs text-gray-500">
          {connectedAddress
            ? "This is not the connected wallet. Switch to "
            : "Connect "}
          <span className="font-mono">{short(address)}</span>
          {connectedAddress
            ? " to cancel these in one transaction."
            : " to cancel these in one transaction."}
        </p>
      </header>

      <SellerListingsView
        mode="readOnly"
        auctions={state.auctions}
        buyNows={state.buyNows}
        meta={state.meta}
      />
    </Section>
  )
}

function Section({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-gray-200 bg-surface p-5">
      {children}
    </div>
  )
}

function short(addr: string): string {
  if (addr.length < 12) return addr
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`
}

function CheckBadge() {
  return (
    <span
      aria-hidden="true"
      className="mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-emerald-100 text-emerald-700"
    >
      <svg
        width="12"
        height="12"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="3"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <polyline points="20 6 9 17 4 12" />
      </svg>
    </span>
  )
}
