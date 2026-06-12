"use client"

import { useCallback, useEffect, useState } from "react"
import { useAccount } from "wagmi"
import { ConnectButton } from "@rainbow-me/rainbowkit"
import type { Address } from "viem"
import { sha256HexOfBlob, ipfsCidToFallbackUrls } from "@pin/shared"
import { PinataProvider } from "@/lib/pinning/pinata"
import { useMuriSetup } from "@/lib/hooks/useMuriSetup"
import { useMuriMint } from "@/lib/hooks/useMuriMint"
import { buildInitConfig } from "@/lib/muri/build-init-config"
import { getEvmNowTxUrl, getEvmNowAddressUrl } from "@/lib/explorer"
import { extractShortError } from "@/components/catalog/catalogErrors"

type EligibleContract = {
  contract: string
  isErc721: boolean
  isErc1155: boolean
  collectionName: string | null
}

const PINATA_KEY_LS = "cg_pin_key"
const PINATA_PROVIDER_LS = "cg_pin_provider"

/** SSR guard — wagmi hooks need the provider mounted. */
export function MuriMintFlow() {
  const [mounted, setMounted] = useState(false)
  useEffect(() => setMounted(true), [])
  if (!mounted) return null
  return <MuriMintFlowInner />
}

function MuriMintFlowInner() {
  const { address } = useAccount()
  const [contracts, setContracts] = useState<EligibleContract[] | null>(null)
  const [loadErr, setLoadErr] = useState<string | null>(null)
  const [selected, setSelected] = useState<EligibleContract | null>(null)

  useEffect(() => {
    if (!address) {
      setContracts(null)
      setSelected(null)
      return
    }
    let cancelled = false
    setContracts(null)
    setLoadErr(null)
    fetch(`/api/muri/eligible/${address.toLowerCase()}`)
      .then((r) => r.json())
      .then((d) => {
        if (cancelled) return
        if (d.error) setLoadErr(d.error)
        else setContracts(d.contracts ?? [])
      })
      .catch(() => !cancelled && setLoadErr("Failed to load your contracts"))
    return () => {
      cancelled = true
    }
  }, [address])

  if (!address) {
    return (
      <Panel>
        <p className="mb-4 text-sm text-gray-600">
          Connect the wallet that administers your Manifold contract to mint a
          MURI-preserved piece.
        </p>
        <ConnectButton />
      </Panel>
    )
  }

  if (selected) {
    return (
      <MintForContract
        contract={selected}
        onBack={() => setSelected(null)}
      />
    )
  }

  return (
    <Panel>
      <h2 className="mb-1 text-sm font-medium">Choose a collection</h2>
      <p className="mb-4 text-xs text-gray-500">
        Your indexed Manifold Creator Core contracts. MURI mints a new
        onchain-preserved token on the one you pick. Existing tokens can&rsquo;t
        be converted.
      </p>
      {loadErr && <p className="text-xs text-red-600">{loadErr}</p>}
      {!contracts && !loadErr && (
        <p className="text-xs text-gray-500">Loading your contracts…</p>
      )}
      {contracts && contracts.length === 0 && (
        <p className="text-xs text-gray-500">
          No Manifold Creator Core contracts found for this wallet. Deploy one at
          studio.manifold.xyz, then refresh.
        </p>
      )}
      <ul className="flex flex-col gap-2">
        {contracts?.map((c) => (
          <li key={c.contract}>
            <button
              onClick={() => setSelected(c)}
              className="flex w-full items-center justify-between rounded border border-gray-200 px-3 py-2 text-left hover:border-gray-400"
            >
              <span className="text-sm">
                {c.collectionName || "Untitled collection"}
              </span>
              <span className="font-mono text-[10px] text-gray-400">
                {c.isErc1155 ? "ERC1155" : "ERC721"} ·{" "}
                {c.contract.slice(0, 6)}…{c.contract.slice(-4)}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </Panel>
  )
}

function MintForContract({
  contract,
  onBack,
}: {
  contract: EligibleContract
  onBack: () => void
}) {
  const addr = contract.contract as Address
  const setup = useMuriSetup(addr)
  const mint = useMuriMint()

  // Compose state
  const [jwt, setJwt] = useState("")
  const [name, setName] = useState("")
  const [description, setDescription] = useState("")
  const [allowCollector, setAllowCollector] = useState(true)
  const [file, setFile] = useState<File | null>(null)
  const [uploading, setUploading] = useState(false)
  const [uploadErr, setUploadErr] = useState<string | null>(null)
  const [uploaded, setUploaded] = useState<{
    cid: string
    uris: string[]
    fileHash: string
    mimeType: string
  } | null>(null)

  useEffect(() => {
    const provider = localStorage.getItem(PINATA_PROVIDER_LS)
    const key = localStorage.getItem(PINATA_KEY_LS)
    if (provider === "pinata" && key) setJwt(key)
  }, [])

  const onUpload = useCallback(async () => {
    if (!file || !jwt) return
    setUploading(true)
    setUploadErr(null)
    try {
      const fileHash = await sha256HexOfBlob(file)
      const { cid } = await new PinataProvider(jwt).uploadFile(file, file.name)
      // Persist the Pinata key for reuse (same BYOK slots as /preserve).
      localStorage.setItem(PINATA_PROVIDER_LS, "pinata")
      localStorage.setItem(PINATA_KEY_LS, jwt)
      setUploaded({
        cid,
        uris: ipfsCidToFallbackUrls(cid),
        fileHash,
        mimeType: file.type || "application/octet-stream",
      })
    } catch (e) {
      setUploadErr(e instanceof Error ? e.message : "Upload failed")
    } finally {
      setUploading(false)
    }
  }, [file, jwt])

  const doMint = useCallback(() => {
    if (!uploaded || !name.trim()) return
    const config = buildInitConfig({
      name: name.trim(),
      description: description.trim(),
      artworkUris: uploaded.uris,
      mimeType: uploaded.mimeType,
      fileHash: uploaded.fileHash,
      isAnimationUri: uploaded.mimeType.startsWith("video/"),
      allowCollectorFallbacks: allowCollector,
    })
    mint.mint({ contract: addr, isErc1155: contract.isErc1155, config })
  }, [uploaded, name, description, allowCollector, addr, contract.isErc1155, mint])

  return (
    <Panel>
      <button
        onClick={onBack}
        className="mb-3 text-xs text-gray-500 hover:text-gray-800"
      >
        ← Back to collections
      </button>
      <h2 className="text-sm font-medium">
        {contract.collectionName || "Untitled collection"}
      </h2>
      <p className="mb-4 font-mono text-[10px] text-gray-400">
        {contract.isErc1155 ? "ERC1155" : "ERC721"} · {addr}
      </p>

      {/* Admin gate */}
      {!setup.readsLoading && !setup.isAdmin && (
        <Note tone="warn">
          The connected wallet isn&rsquo;t an admin of this contract, so it
          can&rsquo;t register the extension or mint here.
        </Note>
      )}

      {/* One-time setup */}
      {setup.isAdmin && !setup.isReady && (
        <section className="mb-5 rounded border border-gray-200 p-3">
          <h3 className="mb-2 text-xs font-medium uppercase tracking-wider text-gray-500">
            One-time setup
          </h3>
          <StepRow
            done={setup.isExtensionRegistered}
            label="1. Authorize the MURI extension on your contract"
            actionLabel="Authorize"
            busy={setup.busy}
            onAction={() => setup.call("extension")}
          />
          <StepRow
            done={setup.isContractRegistered}
            label="2. Register your contract with MURI"
            actionLabel="Register"
            busy={setup.busy}
            disabled={!setup.isExtensionRegistered}
            onAction={() => setup.call("register")}
          />
          {setup.txHash && (
            <TxStatus
              txHash={setup.txHash}
              isSuccess={setup.isSuccess}
              isReverted={setup.isReverted}
              onConfirmed={() => {
                setup.reset()
                void setup.refetch()
              }}
            />
          )}
          {setup.error && (
            <Note tone="warn">{extractShortError(setup.error)}</Note>
          )}
        </section>
      )}

      {/* Compose + mint */}
      {setup.isReady && !mint.isSuccess && (
        <section className="flex flex-col gap-3">
          <Note tone="ok">Contract is MURI-enabled. Mint a new piece below.</Note>

          {!uploaded ? (
            <>
              <label className="text-xs text-gray-600">
                Pinata JWT (uploads the artwork to IPFS; stored locally only)
                <input
                  type="password"
                  value={jwt}
                  onChange={(e) => setJwt(e.target.value)}
                  placeholder="Pinata JWT token"
                  className="mt-1 w-full rounded border border-gray-300 px-2 py-1.5 text-sm"
                />
              </label>
              <input
                type="file"
                onChange={(e) => setFile(e.target.files?.[0] ?? null)}
                className="text-xs"
              />
              <button
                onClick={() => void onUpload()}
                disabled={!file || !jwt || uploading}
                className="self-start rounded bg-fg px-3 py-1.5 text-xs text-bg disabled:opacity-40"
              >
                {uploading ? "Uploading…" : "Upload artwork"}
              </button>
              {uploadErr && <Note tone="warn">{uploadErr}</Note>}
            </>
          ) : (
            <>
              <Note tone="ok">
                Uploaded · {uploaded.uris.length} fallback URLs · SHA-256{" "}
                {uploaded.fileHash.slice(0, 10)}…
              </Note>
              <label className="text-xs text-gray-600">
                Title
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  className="mt-1 w-full rounded border border-gray-300 px-2 py-1.5 text-sm"
                />
              </label>
              <label className="text-xs text-gray-600">
                Description
                <textarea
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  rows={3}
                  className="mt-1 w-full rounded border border-gray-300 px-2 py-1.5 text-sm"
                />
              </label>
              <label className="flex items-center gap-2 text-xs text-gray-600">
                <input
                  type="checkbox"
                  checked={allowCollector}
                  onChange={(e) => setAllowCollector(e.target.checked)}
                />
                Let collectors add their own fallback URLs (collaborative
                preservation)
              </label>
              <button
                onClick={doMint}
                disabled={!name.trim() || mint.busy}
                className="self-start rounded bg-fg px-4 py-2 text-sm text-bg disabled:opacity-40"
              >
                {mint.busy ? "Minting…" : "Mint MURI-native token"}
              </button>
              {mint.txHash && !mint.isSuccess && (
                <TxStatus
                  txHash={mint.txHash}
                  isSuccess={mint.isSuccess}
                  isReverted={mint.isReverted}
                />
              )}
              {mint.error && <Note tone="warn">{extractShortError(mint.error)}</Note>}
            </>
          )}
        </section>
      )}

      {mint.isSuccess && (
        <Note tone="ok">
          Minted. Your new token is preserved onchain via MURI.{" "}
          {mint.txHash && (
            <a
              className="underline"
              href={getEvmNowTxUrl(mint.txHash)}
              target="_blank"
              rel="noopener noreferrer"
            >
              View transaction ↗
            </a>
          )}{" "}
          <a
            className="underline"
            href={getEvmNowAddressUrl(addr)}
            target="_blank"
            rel="noopener noreferrer"
          >
            View contract ↗
          </a>
        </Note>
      )}
    </Panel>
  )
}

function Panel({ children }: { children: React.ReactNode }) {
  return (
    <div className="mx-auto max-w-md rounded-lg border border-gray-200 p-5">
      {children}
    </div>
  )
}

function Note({
  tone,
  children,
}: {
  tone: "ok" | "warn"
  children: React.ReactNode
}) {
  return (
    <p
      className={`rounded border px-3 py-2 text-xs ${
        tone === "ok"
          ? "border-emerald-200 bg-emerald-50 text-emerald-800"
          : "border-amber-200 bg-amber-50 text-amber-800"
      }`}
    >
      {children}
    </p>
  )
}

function StepRow({
  done,
  label,
  actionLabel,
  onAction,
  busy,
  disabled,
}: {
  done: boolean
  label: string
  actionLabel: string
  onAction: () => void
  busy: boolean
  disabled?: boolean
}) {
  return (
    <div className="flex items-center justify-between gap-2 py-1.5">
      <span className={`text-xs ${done ? "text-emerald-700" : "text-gray-700"}`}>
        {done ? "✓ " : ""}
        {label}
      </span>
      {!done && (
        <button
          onClick={onAction}
          disabled={busy || disabled}
          className="rounded bg-fg px-2.5 py-1 text-[11px] text-bg disabled:opacity-40"
        >
          {actionLabel}
        </button>
      )}
    </div>
  )
}

function TxStatus({
  txHash,
  isSuccess,
  isReverted,
  onConfirmed,
}: {
  txHash: `0x${string}`
  isSuccess: boolean
  isReverted: boolean
  onConfirmed?: () => void
}) {
  useEffect(() => {
    if (isSuccess && onConfirmed) onConfirmed()
  }, [isSuccess, onConfirmed])
  return (
    <p className="mt-2 text-[11px] text-gray-500">
      {isReverted ? "Reverted onchain. " : isSuccess ? "Confirmed. " : "Submitted, waiting… "}
      <a
        className="underline"
        href={getEvmNowTxUrl(txHash)}
        target="_blank"
        rel="noopener noreferrer"
      >
        {txHash.slice(0, 10)}…↗
      </a>
    </p>
  )
}
