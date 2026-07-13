"use client"

/**
 * The studio "capture cover" step (docs/pnd-collection-thumbnails.md §5.1):
 * the wizard is already rendering the work for the preview, so the cover is
 * one click — capture the canonical frame from the first test seed, upload
 * it under the artist's own pinning key (BYOK, same key slot the MURI flow
 * uses), and drop the resulting ipfs:// URI into the wizard's cover field.
 *
 * Storage note: BYOK IPFS is the rail this branch has; the thumbnails doc's
 * default becomes one-time permanent storage (Irys→Arweave) when the
 * Editions upload rails land, and this component swaps rails without
 * changing shape.
 */

import { useEffect, useMemo, useState } from "react"

import { captureTokenPNG } from "@/lib/collection-render"
import type { BuildOptions, ContentResolver, TokenData, WorkInput } from "@/lib/collection-render"
import { PinataProvider } from "@/lib/pinning/pinata"
import { BTN_SECONDARY } from "./wizard-ui"

// Shared with the MURI mint flow: one pinning key per browser, artist-owned.
const PINATA_KEY_LS = "cg_pin_key"
const PINATA_PROVIDER_LS = "cg_pin_provider"

export function CaptureCover({
  work,
  tokenData,
  resolver,
  gunzip,
  value,
  onCaptured,
}: {
  work: WorkInput
  tokenData: TokenData
  resolver: ContentResolver
  gunzip: BuildOptions["gunzip"]
  /** The wizard's current cover URI ("" = none set yet). */
  value: string
  onCaptured: (uri: string) => void
}) {
  const [jwt, setJwt] = useState("")
  const [frame, setFrame] = useState<Blob | null>(null)
  const [busy, setBusy] = useState<"capture" | "upload" | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    setJwt(localStorage.getItem(PINATA_KEY_LS) ?? "")
  }, [])

  const frameUrl = useMemo(() => (frame ? URL.createObjectURL(frame) : null), [frame])
  useEffect(() => {
    return () => {
      if (frameUrl) URL.revokeObjectURL(frameUrl)
    }
  }, [frameUrl])

  const capture = async () => {
    setBusy("capture")
    setError(null)
    try {
      setFrame(await captureTokenPNG(work, tokenData, resolver, gunzip))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
    }
  }

  const upload = async () => {
    if (!frame || !jwt) return
    setBusy("upload")
    setError(null)
    try {
      const file = new File([frame], "cover.png", { type: "image/png" })
      const { cid } = await new PinataProvider(jwt).uploadFile(file, file.name)
      localStorage.setItem(PINATA_PROVIDER_LS, "pinata")
      localStorage.setItem(PINATA_KEY_LS, jwt)
      onCaptured(`ipfs://${cid}`)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="space-y-2 rounded border border-gray-200 p-3">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h4 className="text-xs font-medium">Cover image</h4>
          <p className="text-[11px] text-gray-500 leading-relaxed">
            Marketplaces show a static cover until per-token frames land. Capture the
            canonical frame of the first test seed, uploaded under your own pinning key.
          </p>
        </div>
        <button onClick={capture} disabled={busy !== null} className={BTN_SECONDARY}>
          {busy === "capture" ? "Capturing…" : frame ? "Recapture" : "Capture frame"}
        </button>
      </div>

      {frameUrl && (
        <div className="flex items-end gap-3">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={frameUrl}
            alt="Captured cover frame"
            className="h-24 w-24 rounded border border-gray-200 object-cover"
          />
          <div className="flex-1 space-y-1.5">
            <input
              type="password"
              value={jwt}
              onChange={(e) => setJwt(e.target.value.trim())}
              placeholder="Pinata JWT (yours; stored in this browser only)"
              className="w-full rounded border border-gray-200 px-2 py-1 text-xs"
            />
            <button
              onClick={upload}
              disabled={!jwt || busy !== null}
              className={BTN_SECONDARY}
            >
              {busy === "upload" ? "Uploading…" : "Upload & use as cover"}
            </button>
          </div>
        </div>
      )}

      {value && (
        <p className="break-all text-[11px] text-gray-500">
          cover: <span className="font-mono">{value}</span>
        </p>
      )}
      {error && <p className="text-[11px] text-red-600">{error}</p>}
    </div>
  )
}
