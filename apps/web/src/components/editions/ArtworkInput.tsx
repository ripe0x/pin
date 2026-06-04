"use client"

/**
 * The sovereign storage substrate for the editions create flow.
 *
 * One affordance, identical across backends: drop a file, hash it (SHA-256),
 * upload it from the artist's OWN wallet or key, set `artworkURI`, and show
 * honest status. PND never custodies, pins, or pays for the bytes.
 *
 *   - Arweave via Irys (default): account-less, paid once from the connected
 *     wallet in ETH, free under 100 KB. See lib/storage/arweave.ts. (Framed as
 *     "via Irys" rather than claiming permanence until a live upload confirms
 *     the current Irys endpoint settles to Arweave.)
 *   - IPFS via the artist's own Pinata key (BYO, stored only in the browser),
 *     mirroring the /muri + /preserve upload pattern. Pinned while their plan
 *     is active; not permanent.
 *   - Paste a URI you already host (escape hatch, never removed).
 */

import { useCallback, useEffect, useState } from "react"
import { usePublicClient, useWalletClient } from "wagmi"
import { ipfsToHttp, sha256HexOfBlob } from "@pin/shared"
import { IRYS_FREE_LIMIT_BYTES, uploadToArweave } from "@/lib/storage/arweave"
import { uploadToIpfs } from "@/lib/storage/ipfs"
import type { StorageBackend, StorageUploadResult } from "@/lib/storage/types"
import { Hint, Segmented, inputCls, labelCls, primaryBtnCls } from "./form-ui"

// Same BYOK localStorage slots /preserve and /muri use, so an artist who has
// already pasted their Pinata key elsewhere re-enters nothing.
const PINATA_KEY_LS = "cg_pin_key"
const PINATA_PROVIDER_LS = "cg_pin_provider"

type Mode = "upload" | "uri"

type Uploaded = StorageUploadResult & {
  fileHash: string
  /** null = retrievability check in flight. */
  retrievable: boolean | null
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

/**
 * Probe whether a URL resolves as a loadable image. Uses an <img> load (not
 * fetch HEAD) so it works without the gateway sending CORS headers. The
 * honest-status signal: we only say "retrievable" when the bytes come back.
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
  const [dragOver, setDragOver] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [uploaded, setUploaded] = useState<Uploaded | null>(null)
  const [localPreview, setLocalPreview] = useState<string | null>(null)

  const { data: walletClient } = useWalletClient()
  const publicClient = usePublicClient()

  useEffect(() => {
    const provider = localStorage.getItem(PINATA_PROVIDER_LS)
    const key = localStorage.getItem(PINATA_KEY_LS)
    if (provider === "pinata" && key) setJwt(key)
  }, [])

  // Local object-URL preview for the picked file (revoked on change/unmount).
  useEffect(() => {
    if (!file) {
      setLocalPreview(null)
      return
    }
    const url = URL.createObjectURL(file)
    setLocalPreview(url)
    return () => URL.revokeObjectURL(url)
  }, [file])

  const pickFile = useCallback((f: File | null) => {
    setFile(f)
    setUploaded(null)
    setError(null)
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
        localStorage.setItem(PINATA_PROVIDER_LS, "pinata")
        localStorage.setItem(PINATA_KEY_LS, jwt)
      }
      onChange(result.uri)
      setUploaded({ ...result, fileHash, retrievable: null })
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
  const previewUrl =
    uploaded?.gatewayUrl ?? localPreview ?? (value && mode === "uri" ? ipfsToHttp(value) : null)
  const showPreview = !!previewUrl && (previewUrl.startsWith("http") || previewUrl.startsWith("blob:"))
  const canUpload =
    !busyAll && !!file && !uploaded && (backend === "arweave" ? !!walletClient : jwt.length > 0)

  return (
    <div className="space-y-3">
      <div className="flex justify-end">
        <Segmented
          value={mode}
          onChange={(v) => setMode(v as Mode)}
          disabled={busyAll}
          options={[
            { value: "upload", label: "Upload" },
            { value: "uri", label: "Paste URI" },
          ]}
        />
      </div>

      {mode === "upload" ? (
        <div className="space-y-3">
          {/* Dropzone */}
          <label
            onDragOver={(e) => {
              e.preventDefault()
              if (!busyAll) setDragOver(true)
            }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(e) => {
              e.preventDefault()
              setDragOver(false)
              if (!busyAll) pickFile(e.dataTransfer.files?.[0] ?? null)
            }}
            className={`group relative flex h-44 w-full cursor-pointer items-center justify-center overflow-hidden border border-dashed bg-surface-muted/40 transition-colors ${
              dragOver ? "border-border-strong bg-surface-muted" : "border-border hover:border-border-strong"
            } ${busyAll ? "pointer-events-none opacity-60" : ""}`}
          >
            <input
              type="file"
              accept="image/*"
              disabled={busyAll}
              onChange={(e) => pickFile(e.target.files?.[0] ?? null)}
              className="sr-only"
            />
            {showPreview ? (
              <>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={previewUrl!} alt="Artwork preview" className="h-full w-full object-contain" />
                <span className="absolute bottom-2 right-2 bg-fg/80 px-2 py-1 text-[9px] font-mono uppercase tracking-[0.1em] text-bg opacity-0 transition-opacity group-hover:opacity-100">
                  Replace
                </span>
              </>
            ) : (
              <div className="px-6 text-center">
                <p className="text-sm text-fg-muted">
                  Drop an image, or <span className="text-fg underline">choose a file</span>
                </p>
                <p className="mt-1 text-[10px] font-mono uppercase tracking-[0.1em] text-fg-subtle">
                  PNG · JPG · GIF · SVG
                </p>
              </div>
            )}
          </label>

          {file && (
            <div className="flex items-center justify-between gap-3 text-[11px] font-mono text-fg-muted">
              <span className="truncate">{file.name}</span>
              <span className="shrink-0 tabular-nums text-fg-subtle">{formatBytes(file.size)}</span>
            </div>
          )}

          {/* Backend + (for IPFS) key */}
          <div className="flex flex-wrap items-center gap-2">
            <span className={labelCls}>Store on</span>
            <Segmented
              value={backend}
              onChange={(v) => setBackend(v as StorageBackend)}
              disabled={busyAll}
              options={[
                { value: "arweave", label: "Arweave (Irys)" },
                { value: "ipfs", label: "IPFS (your key)" },
              ]}
            />
          </div>

          {backend === "ipfs" && (
            <input
              type="password"
              value={jwt}
              onChange={(e) => setJwt(e.target.value)}
              placeholder="Pinata JWT (stored in your browser only)"
              className={inputCls}
              disabled={busyAll}
            />
          )}

          {file && !uploaded && (
            <Hint>
              {backend === "arweave"
                ? overFree
                  ? "Uploaded via Irys, paid once from your wallet in ETH. Storage cost is separate from the deploy gas."
                  : "Under 100 KB, so this uploads via Irys for free, with no funding transaction."
                : "Uploaded to IPFS via your own Pinata account; the key stays in your browser. Pinned while your plan is active, not permanent."}
            </Hint>
          )}

          {file && !uploaded && (
            <button onClick={() => void onUpload()} disabled={!canUpload} className={primaryBtnCls}>
              {busy
                ? "Uploading…"
                : backend === "arweave"
                  ? "Upload via Irys"
                  : "Upload to IPFS"}
            </button>
          )}

          {file && backend === "arweave" && !walletClient && !uploaded && (
            <Hint>Connect your wallet to upload via Irys.</Hint>
          )}
          {error && <p className="text-xs text-red-500">{error}</p>}
        </div>
      ) : (
        <div className="space-y-3">
          <input
            className={inputCls}
            value={value}
            onChange={(e) => {
              onChange(e.target.value.trim())
              setUploaded(null)
            }}
            placeholder="ipfs://…  ·  ar://…  ·  https://…"
            disabled={busyAll}
          />
          <Hint>
            Paste a CID or URI you already host. The artwork stays yours to keep
            pinned. PND does not host or pin it.
          </Hint>
          {showPreview && (
            <div className="h-44 w-full overflow-hidden border border-border bg-surface-muted/40">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={previewUrl!} alt="Artwork preview" className="h-full w-full object-contain" />
            </div>
          )}
        </div>
      )}

      {uploaded && (
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 border-t border-border pt-3 text-[10px] font-mono">
          <span className="inline-flex items-center gap-1.5 uppercase tracking-[0.1em] text-fg">
            <span
              className={`h-1.5 w-1.5 rounded-full ${
                uploaded.retrievable === null
                  ? "bg-fg-subtle"
                  : uploaded.retrievable
                    ? "bg-status-available"
                    : "bg-status-upcoming"
              }`}
            />
            {uploaded.backend === "arweave" ? "Uploaded via Irys" : "Uploaded to IPFS"}
          </span>
          <span className="text-fg-subtle">
            {uploaded.retrievable === null
              ? "checking…"
              : uploaded.retrievable
                ? "retrievable"
                : "gateway may take a moment"}
          </span>
          <span className="ml-auto text-fg-subtle">SHA-256 {uploaded.fileHash.slice(0, 10)}…</span>
        </div>
      )}
    </div>
  )
}
