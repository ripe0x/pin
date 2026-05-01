"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { useAccount } from "wagmi"
import { ConnectButton } from "@rainbow-me/rainbowkit"
import { useArtistHouse } from "@/components/auction/useArtistHouse"
import { AuctionTermsForm } from "@/components/auction/AuctionTermsForm"
import { TokenPreview } from "@/components/auction/TokenPreview"

const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/

type OwnedItem = {
  contract: string
  tokenId: string
  name: string | null
  imageUrl: string | null
}

type OwnedPageResp = {
  address: string
  items: OwnedItem[]
  nextPageKey: string | null
}

export function AuctionNewClient() {
  // Wagmi hooks need WagmiProvider mounted, so gate all wagmi-dependent UI
  // behind a mount flag (mirrors StartAuctionCTA / ArtistHeader pattern).
  const [mounted, setMounted] = useState(false)
  useEffect(() => setMounted(true), [])
  if (!mounted) return <PageShell />

  return <Inner />
}

function PageShell({ children }: { children?: React.ReactNode }) {
  return (
    <div className="mx-auto max-w-2xl px-6 py-12">
      <div className="mb-8">
        <h1 className="text-2xl font-semibold tracking-tight">
          Start an auction
        </h1>
        <p className="text-sm text-gray-500 mt-1">
          List any ERC-721 you own through your sovereign auction house.
        </p>
      </div>
      {children}
    </div>
  )
}

function Inner() {
  const { address } = useAccount()
  const { houseAddress, isLoading: houseLoading } = useArtistHouse(address)

  if (!address) {
    return (
      <PageShell>
        <div className="rounded border border-gray-200 bg-surface p-5 space-y-3">
          <p className="text-sm text-gray-500">
            Connect your wallet to list a token.
          </p>
          <ConnectButton.Custom>
            {({ openConnectModal }) => (
              <button
                onClick={openConnectModal}
                className="block w-full text-center text-sm font-medium py-3 bg-fg text-bg hover:opacity-80 transition-colors"
              >
                Connect wallet
              </button>
            )}
          </ConnectButton.Custom>
        </div>
      </PageShell>
    )
  }

  if (houseLoading) {
    return (
      <PageShell>
        <p className="text-sm text-gray-400">Checking your auction house…</p>
      </PageShell>
    )
  }

  if (!houseAddress) {
    return (
      <PageShell>
        <div className="rounded border border-gray-200 bg-surface p-5 space-y-3">
          <h2 className="text-base font-semibold tracking-tight">
            Deploy your auction house first
          </h2>
          <p className="text-sm text-gray-500">
            You need a sovereign auction house contract before you can list a
            token. It&apos;s a one-time deploy.
          </p>
          <Link
            href={`/artist/${address}`}
            className="block w-full text-center text-sm font-medium py-3 bg-fg text-bg hover:opacity-80 transition-colors"
          >
            Go to your profile to deploy →
          </Link>
        </div>
      </PageShell>
    )
  }

  return (
    <PageShell>
      <ListForm
        connected={address as `0x${string}`}
        houseAddress={houseAddress}
      />
    </PageShell>
  )
}

function ListForm({
  connected,
  houseAddress,
}: {
  connected: `0x${string}`
  houseAddress: `0x${string}`
}) {
  const router = useRouter()
  const [contractInput, setContractInput] = useState("")
  const [tokenIdInput, setTokenIdInput] = useState("")
  const [owned, setOwned] = useState(false)
  const previewRef = useRef<HTMLDivElement | null>(null)

  const contractValid = ADDRESS_RE.test(contractInput.trim())
  const tokenIdValid = /^[0-9]+$/.test(tokenIdInput.trim())
  const ready = contractValid && tokenIdValid

  // Stable callback so TokenPreview's effect dep is honest.
  const handleOwnedChange = useCallback((next: boolean) => {
    setOwned(next)
  }, [])

  function handlePick(item: { contract: string; tokenId: string }) {
    setContractInput(item.contract)
    setTokenIdInput(item.tokenId)
    // Defer scroll so the preview mounts first.
    setTimeout(() => {
      previewRef.current?.scrollIntoView({ behavior: "smooth", block: "start" })
    }, 50)
  }

  function handleCreated() {
    // Land the user on the token detail page so they see the live auction.
    router.push(`/${contractInput.trim()}/${tokenIdInput.trim()}`)
  }

  return (
    <div className="space-y-10">
      <section className="space-y-4">
        <div>
          <h2 className="text-base font-semibold tracking-tight">
            List any token you own
          </h2>
          <p className="text-sm text-gray-500 mt-1">
            Paste the NFT contract address and token ID. Works for any ERC-721
            on Ethereum mainnet.
          </p>
        </div>
        <div className="grid grid-cols-1 gap-3">
          <label className="block">
            <span className="text-xs uppercase tracking-wider text-gray-500">
              Contract address
            </span>
            <input
              value={contractInput}
              onChange={(e) => setContractInput(e.target.value)}
              placeholder="0x…"
              spellCheck={false}
              className="mt-1 w-full px-3 py-2.5 text-sm font-mono border border-gray-200 focus:border-gray-400 transition-colors rounded outline-none bg-transparent"
            />
            {contractInput && !contractValid && (
              <p className="text-xs text-red-500 mt-1">
                Must be a 0x… 40-character address.
              </p>
            )}
          </label>
          <label className="block">
            <span className="text-xs uppercase tracking-wider text-gray-500">
              Token ID
            </span>
            <input
              value={tokenIdInput}
              onChange={(e) => setTokenIdInput(e.target.value)}
              placeholder="0"
              spellCheck={false}
              className="mt-1 w-full px-3 py-2.5 text-sm font-mono border border-gray-200 focus:border-gray-400 transition-colors rounded outline-none bg-transparent"
            />
            {tokenIdInput && !tokenIdValid && (
              <p className="text-xs text-red-500 mt-1">
                Must be a positive integer.
              </p>
            )}
          </label>
          {!ready && (
            <p className="text-xs text-gray-400">
              After we verify you own this token, you&apos;ll set the reserve
              price and auction duration below.
            </p>
          )}
        </div>

        {ready && (
          <div ref={previewRef} className="space-y-4">
            <TokenPreview
              key={`${contractInput.trim()}:${tokenIdInput.trim()}`}
              nftContract={contractInput.trim() as `0x${string}`}
              tokenId={tokenIdInput.trim()}
              expectedOwner={connected}
              onOwnedChange={handleOwnedChange}
            />
            {owned && (
              <div className="rounded border border-gray-200 bg-surface p-5">
                <AuctionTermsForm
                  houseAddress={houseAddress}
                  nftContract={contractInput.trim() as `0x${string}`}
                  tokenId={tokenIdInput.trim()}
                  onSuccess={handleCreated}
                />
              </div>
            )}
          </div>
        )}
      </section>

      <Picker connected={connected} onPick={handlePick} />
    </div>
  )
}

function Picker({
  connected,
  onPick,
}: {
  connected: `0x${string}`
  onPick: (item: OwnedItem) => void
}) {
  const [items, setItems] = useState<OwnedItem[]>([])
  const [nextPageKey, setNextPageKey] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [initialized, setInitialized] = useState(false)

  const loadPage = useCallback(
    async (cursor: string | null) => {
      setLoading(true)
      setError(null)
      try {
        const params = cursor ? `?pageKey=${encodeURIComponent(cursor)}` : ""
        const res = await fetch(`/api/wallet/${connected}/owned${params}`)
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const json = (await res.json()) as OwnedPageResp
        setItems((prev) => (cursor ? [...prev, ...json.items] : json.items))
        setNextPageKey(json.nextPageKey)
      } catch (e) {
        setError(String((e as Error)?.message ?? e))
      } finally {
        setLoading(false)
      }
    },
    [connected],
  )

  // Reset + load first page whenever the connected wallet changes.
  useEffect(() => {
    setItems([])
    setNextPageKey(null)
    setInitialized(false)
  }, [connected])

  useEffect(() => {
    if (initialized) return
    setInitialized(true)
    loadPage(null)
  }, [initialized, loadPage])

  return (
    <section className="space-y-4">
      <div>
        <h2 className="text-base font-semibold tracking-tight">
          Or pick from tokens you own
        </h2>
        <p className="text-xs text-gray-500 mt-1">
          Every ERC-721 currently held by your wallet, via Alchemy. Spam
          collections are filtered out.
        </p>
      </div>

      {error ? (
        <p className="text-sm text-red-500">Couldn&apos;t load your tokens.</p>
      ) : items.length === 0 && loading ? (
        <p className="text-sm text-gray-400">Loading…</p>
      ) : items.length === 0 ? (
        <p className="text-sm text-gray-400">
          No ERC-721 tokens found in this wallet.
        </p>
      ) : (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
            {items.map((item) => (
              <button
                key={`${item.contract}:${item.tokenId}`}
                onClick={() => onPick(item)}
                className="text-left group"
              >
                <div className="aspect-square bg-gray-100 rounded overflow-hidden border border-gray-200 group-hover:border-gray-400 transition-colors">
                  {item.imageUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={item.imageUrl}
                      alt={item.name ?? `#${item.tokenId}`}
                      className="w-full h-full object-cover"
                      loading="lazy"
                    />
                  ) : (
                    <div className="w-full h-full flex items-center justify-center text-xs text-gray-400">
                      No image
                    </div>
                  )}
                </div>
                <p className="text-xs mt-1.5 truncate">
                  {item.name ?? `#${item.tokenId}`}
                </p>
              </button>
            ))}
          </div>
          {nextPageKey && (
            <button
              onClick={() => loadPage(nextPageKey)}
              disabled={loading}
              className="block w-full text-center text-sm font-medium py-3 border border-gray-200 hover:border-gray-400 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {loading ? "Loading…" : "Load more"}
            </button>
          )}
        </>
      )}
    </section>
  )
}
