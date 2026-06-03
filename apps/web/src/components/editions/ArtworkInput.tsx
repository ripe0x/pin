"use client"

/**
 * The sovereign storage substrate for the editions create flow.
 *
 * One affordance, identical across backends: drop a file, hash it (SHA-256),
 * upload it from the artist's OWN wallet or key, set `artworkURI`, and show
 * honest status. PND never custodies, pins, or pays for the bytes.
 *
 *   - Arweave via Irys (default): account-less, paid once from the connected
 *     wallet in ETH, free under 100 KB. See lib/storage/arweave.ts. (We frame
 *     this as "via Irys" rather than claiming permanence until a live upload
 *     confirms the current Irys endpoint settles to Arweave.)
 *   - IPFS via the artist's own Pinata key (BYO, stored only in the browser),
 *     mirroring the /muri + /preserve upload pattern. Pinned while their plan
 *     is active; not permanent.
 *   - Paste a URI you already host (escape hatch, never removed).
 *
 * The deploy transaction is unchanged: it still passes `cfg.artworkURI`. The
 * upload is a browser pre-step, not a new on-chain step and not a PND server.
 */

import { useCallback, useEffect, useState } from "react"
import { usePublicClient, useWalletClient } from "wagmi"
import { ipfsToHttp, sha256HexOfBlob } from "@pin/shared"
import { OptimizedImage } from "@/components/OptimizedImage"
import { IRYS_FREE_LIMIT_BYTES, uploadToArweave } from "@/lib/storage/arweave"
import { uploadToIpfs } from "@/lib/storage/ipfs"
import type { StorageBackend, StorageUploadResult } from "@/lib/storage/types"

// Same BYOK localStorage slots /preserve and /muri use, so an artist who has
// already pasted their Pinata key elsewhere re-enters nothing.
const PINATA_KEY_LS = "cg_pin_key"
const PINATA_PROVIDER_LS = "cg_pin_provider"

const LABEL = "block text-[10px] font-mono uppercase tracking-wider text-gray-400 mb-1.5"
const INPUT =
  "w-full px-3 py-2 text-xs font-mono bg-surface border border-gray-200 focus:border-gray-400 outline-none transition-colors disabled:opacity-40"
const HELP = "mt-1.5 text-[10px] font-mono text-gray-400 leading-relaxed"
const UPLOAD_BTN =
  "text-[10px] font-mono font-medium uppercase tracking-wider px-4 py-2 bg-fg text-bg hover:opacity-80 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"

type Mode = "upload" | "uri"

type Uploaded = StorageUploadResult & {
  fileHash: string
  /** null = retrievability check in flight. */
  retrievable: boolean | null
}

/**
 * Probe whether a URL resolves as a loadable image. Uses an <img> load (not
 * fetch HEAD) so it works without the gateway sending CORS headers. The
 * honest-status signal: we only say "retrievable" when the bytes actually
 * come back.
 */
function imageResolves(url: string, timeoutMs = 8000): Promise<boolean> {
  return new Promise((resolve) => {
    const img = new Image()
    const finish = (ok: boolean) => {
      img.onload = null
      img.onerror = null
      resolve(ok)
    }
    const t = setTimeout(() => finish(false), timeoutMs)
    img.onload = () => {
      clearTimeout(t)
      finish(true)
    }
    img.onerror = () => {
      clearTimeout(t)
      finish(false)
    }
    img.src = url
  })
}

export function ArtworkInput({
  value,
  onChange,
  disabled,
}: {
  value: string
  onChange: (uri: string) => void
  disabled?: boolean
}) {
  const [mode, setMode] = useState<Mode>("upload")
  const [backend, setBackend] = useState<StorageBackend>("arweave")
  const [file, setFile] = useState<File | null>(null)
  const [jwt, setJwt] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [uploaded, setUploaded] = useState<Uploaded | null>(null)

  const { data: walletClient } = useWalletClient()
  const publicClient = usePublicClient()

  useEffect(() => {
    const provider = localStorage.getItem(PINATA_PROVIDER_LS)
    const key = localStorage.getItem(PINATA_KEY_LS)
    if (provider === "pinata" && key) setJwt(key)
  }, [])

  const onUpload = useCallback(async () => {
    if (!file) return
    setBusy(true)
    setError(null)
    try {
      const fileHash = await sha256HexOfBlob(file)
      let result: StorageUploadResult
      if (backend === "arweave") {
        if (!walletClient || !publicClient) {
          throw new Error("Connect your wallet to upload via Irys")
        }
        result = await uploadToArweave(file, walletClient, publicClient)
      } else {
        if (!jwt) throw new Error("Enter your Pinata key to upload to IPFS")
        result = await uploadToIpfs(file, jwt)
        // Persist the key for reuse (same BYOK slots as /preserve and /muri).
        localStorage.setItem(PINATA_PROVIDER_LS, "pinata")
        localStorage.setItem(PINATA_KEY_LS, jwt)
      }
      onChange(result.uri)
      setUploaded({ ...result, fileHash, retrievable: null })
      // Honest status: don't claim retrievable until the bytes actually load.
      const ok = await imageResolves(result.gatewayUrl)
      setUploaded((u) => (u && u.uri === result.uri ? { ...u, retrievable: ok } : u))
    } catch (e) {
      setError(e instanceof Error ? e.message : "Upload failed")
    } finally {
      setBusy(false)
    }
  }, [file, backend, walletClient, publicClient, jwt, onChange])

  const busyAll = busy || !!disabled
  const overFree = !!file && file.size >= IRYS_FREE_LIMIT_BYTES
  // Prefer the just-uploaded gateway URL (serves immediately); else resolve
  // whatever URI is currently set (handles ipfs://, ar://, https://).
  const previewUrl = uploaded?.gatewayUrl ?? (value ? ipfsToHttp(value) : "")
  const canUpload =
    !busyAll && !!file && (backend === "arweave" ? !!walletClient : jwt.length > 0)

  return (
    <div>
      <label className={LABEL}>Artwork</label>

      <div className="mb-3 flex gap-1">
        <Tab active={mode === "upload"} disabled={busyAll} onClick={() => setMode("upload")}>
          Upload a file
        </Tab>
        <Tab active={mode === "uri"} disabled={busyAll} onClick={() => setMode("uri")}>
          I have a URI
        </Tab>
      </div>

      {mode === "upload" ? (
        <div className="space-y-3">
          <div className="flex gap-1">
            <Tab active={backend === "arweave"} disabled={busyAll} onClick={() => setBackend("arweave")}>
              Arweave via Irys
            </Tab>
            <Tab active={backend === "ipfs"} disabled={busyAll} onClick={() => setBackend("ipfs")}>
              IPFS (your Pinata key)
            </Tab>
          </div>

          {backend === "ipfs" && (
            <input
              type="password"
              value={jwt}
              onChange={(e) => setJwt(e.target.value)}
              placeholder="Pinata JWT (stored in your browser only)"
              className={INPUT}
              disabled={busyAll}
            />
          )}

          <input
            type="file"
            accept="image/*"
            onChange={(e) => {
              setFile(e.target.files?.[0] ?? null)
              setUploaded(null)
              setError(null)
            }}
            disabled={busyAll}
            className="block w-full text-[11px] font-mono text-gray-500 file:mr-3 file:border file:border-gray-200 file:bg-surface file:px-3 file:py-1.5 file:text-[10px] file:font-mono file:uppercase file:tracking-wider file:text-gray-600 disabled:opacity-40"
          />

          {file && (
            <p className={HELP}>
              {backend === "arweave"
                ? overFree
                  ? "Uploaded via Irys, paid once from your wallet in ETH. Storage cost is separate from the deploy gas."
                  : "Under 100 KB: uploaded via Irys for free, no funding transaction."
                : "Uploaded to IPFS via your own Pinata account. The key stays in your browser. Pinned while your plan is active, not permanent."}
            </p>
          )}

          <button onClick={() => void onUpload()} disabled={!canUpload} className={UPLOAD_BTN}>
            {busy
              ? "Uploading…"
              : backend === "arweave"
                ? "Upload via Irys"
                : "Upload to IPFS"}
          </button>

          {backend === "arweave" && !walletClient && (
            <p className={HELP}>Connect your wallet to upload via Irys.</p>
          )}
          {error && <p className="text-[10px] font-mono text-red-500 break-words">{error}</p>}
        </div>
      ) : (
        <div>
          <input
            className={INPUT}
            value={value}
            onChange={(e) => {
              onChange(e.target.value.trim())
              setUploaded(null)
            }}
            placeholder="ipfs://… / ar://… / https://…"
            disabled={busyAll}
          />
          <p className={HELP}>
            Paste a CID or URI you already host. The artwork stays yours to keep
            pinned. PND does not host or pin it.
          </p>
        </div>
      )}

      {uploaded && (
        <p className={`${HELP} mt-2`}>
          {uploaded.backend === "arweave"
            ? "Uploaded via Irys"
            : "Uploaded to IPFS (your Pinata account)"}{" "}
          · <span className="break-all">{uploaded.uri.slice(0, 30)}…</span> · SHA-256{" "}
          {uploaded.fileHash.slice(0, 10)}… ·{" "}
          {uploaded.retrievable === null
            ? "checking retrievability…"
            : uploaded.retrievable
              ? "retrievable"
              : "uploaded; the gateway may take a moment to serve it"}
        </p>
      )}

      {previewUrl.startsWith("http") && (
        <div className="mt-3 aspect-square w-28 overflow-hidden rounded border border-gray-200 bg-surface-muted">
          <OptimizedImage
            src={previewUrl}
            alt="Artwork preview"
            width={224}
            className="h-full w-full object-cover"
          />
        </div>
      )}
    </div>
  )
}

function Tab({
  active,
  disabled,
  onClick,
  children,
}: {
  active: boolean
  disabled?: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`px-2.5 py-1.5 text-[10px] font-mono uppercase tracking-wider border transition-colors disabled:opacity-40 ${
        active
          ? "border-fg bg-fg text-bg"
          : "border-gray-200 text-gray-500 hover:border-gray-400"
      }`}
    >
      {children}
    </button>
  )
}
