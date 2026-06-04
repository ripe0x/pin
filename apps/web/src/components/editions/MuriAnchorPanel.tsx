"use client"

/**
 * Phase 2: the editions-on-MURI anchor flow. Lets the artist make an edition's
 * shared artwork permanent onchain via MURI, without PND ever custodying it.
 *
 * Three artist-signed steps, all post-deploy:
 *   1. Register the edition with the shared operator (MURI.registerContract).
 *   2. Anchor the artwork (operator.anchor): writes the fallback URI array +
 *      SHA-256 hash into MURI under the canonical id. The fallbacks + hash are
 *      derived here from the edition's existing artworkURI (content-addressed,
 *      so the hash is deterministic) using the same buildInitConfig the /muri
 *      flow uses.
 *   3. Switch the edition to PNDMuriRenderer (edition.setRenderer), so every
 *      token sources its artwork from MURI while keeping its live Mint Mark.
 *
 * RPC discipline: this renders nothing for non-owners, so the public edition
 * page triggers zero chain reads. Even for the owner, the MURI status reads
 * fire only after they expand the panel.
 */

import { useCallback, useEffect, useState } from "react"
import {
  useAccount,
  useReadContract,
  useWaitForTransactionReceipt,
  useWriteContract,
} from "wagmi"
import type { Address } from "viem"
import {
  muriProtocolAbi,
  pndEditionsAbi,
  pndEditionsMuriOperatorAbi,
} from "@pin/abi"
import {
  extractArweaveId,
  extractBareCid,
  ipfsCidToFallbackUrls,
  ipfsToHttp,
  sha256HexOfBlob,
} from "@pin/shared"
import {
  muriProtocolAddress,
  pndEditionsMuriOperator,
  pndMuriRenderer,
} from "@/lib/pnd-editions"
import { buildInitConfig } from "@/lib/muri/build-init-config"
import { getEvmNowTxUrl } from "@/lib/explorer"

const CANONICAL_TOKEN_ID = 0n

const LABEL = "text-[10px] font-mono uppercase tracking-[0.1em] text-fg-subtle"
const HELP = "text-xs leading-relaxed text-fg-muted"
const BTN =
  "shrink-0 bg-fg px-3 py-1.5 text-[10px] font-mono uppercase tracking-[0.1em] text-bg hover:opacity-80 transition-opacity disabled:opacity-40 disabled:cursor-not-allowed"

type Props = {
  edition: Address
  owner: Address
  /** The edition's currently-set renderer (from the server read; no RPC here). */
  currentRenderer: Address
  artworkURI: string
  editionName: string
}

/** Build the resilient fallback URI set for an artwork URI (no network). */
function deriveFallbackUris(artworkURI: string): string[] {
  const cid = extractBareCid(artworkURI)
  if (cid) return ipfsCidToFallbackUrls(cid)
  const ar = extractArweaveId(artworkURI)
  if (ar) return [`https://arweave.net/${ar}`]
  return artworkURI ? [artworkURI] : []
}

export function MuriAnchorPanel(props: Props) {
  const [mounted, setMounted] = useState(false)
  useEffect(() => setMounted(true), [])
  if (!mounted) return null
  return <MuriAnchorPanelInner {...props} />
}

function MuriAnchorPanelInner({
  edition,
  owner,
  currentRenderer,
  artworkURI,
  editionName,
}: Props) {
  const { address } = useAccount()
  const isOwner = !!address && address.toLowerCase() === owner.toLowerCase()

  const operator = pndEditionsMuriOperator()
  const renderer = pndMuriRenderer()
  const muri = muriProtocolAddress()

  // Auto-expand when this edition already uses the MURI renderer (the artist
  // picked the Permanent tier at create), nudging them to finish anchoring.
  const [open, setOpen] = useState(
    () => !!renderer && currentRenderer.toLowerCase() === renderer.toLowerCase(),
  )
  const [preparing, setPreparing] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const { writeContract, data: txHash, isPending, reset } = useWriteContract()
  const { isLoading: mining, isSuccess: mined } = useWaitForTransactionReceipt({ hash: txHash })

  // Owner-only, on-expand status reads. Disabled (no RPC) otherwise.
  const enabled = open && isOwner && !!operator
  const { data: registeredOperator, refetch: refetchOp } = useReadContract({
    address: muri,
    abi: muriProtocolAbi,
    functionName: "isContractOperator",
    args: operator ? [edition, operator] : undefined,
    query: { enabled },
  })
  const { data: artwork, refetch: refetchArt } = useReadContract({
    address: muri,
    abi: muriProtocolAbi,
    functionName: "getArtwork",
    args: [edition, CANONICAL_TOKEN_ID],
    query: { enabled },
  })

  // Re-read status after a confirmed step.
  useEffect(() => {
    if (mined) {
      void refetchOp()
      void refetchArt()
      reset()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mined])

  const register = useCallback(() => {
    if (!operator) return
    setErr(null)
    writeContract({
      address: muri,
      abi: muriProtocolAbi,
      functionName: "registerContract",
      args: [edition, operator],
    })
  }, [operator, muri, edition, writeContract])

  const anchor = useCallback(async () => {
    if (!operator) return
    setErr(null)
    setPreparing(true)
    try {
      const uris = deriveFallbackUris(artworkURI)
      if (uris.length === 0) throw new Error("This edition has no artwork URI to anchor.")
      // Fetch the bytes once to compute the integrity hash + mime type. The
      // artwork is content-addressed, so this hash matches every fallback copy.
      const res = await fetch(ipfsToHttp(artworkURI))
      if (!res.ok) throw new Error(`Could not fetch the artwork to hash it (${res.status}).`)
      const blob = await res.blob()
      const fileHash = await sha256HexOfBlob(blob)
      const mimeType = res.headers.get("content-type") || blob.type || "application/octet-stream"

      const config = buildInitConfig({
        name: editionName,
        description: "PND Edition artwork, preserved onchain via MURI.",
        artworkUris: uris,
        mimeType,
        fileHash,
        isAnimationUri: mimeType.startsWith("video/"),
        allowCollectorFallbacks: true,
      })
      writeContract({
        address: operator,
        abi: pndEditionsMuriOperatorAbi,
        functionName: "anchor",
        args: [edition, config],
      })
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed to prepare the anchor.")
    } finally {
      setPreparing(false)
    }
  }, [operator, artworkURI, editionName, edition, writeContract])

  const switchRenderer = useCallback(() => {
    if (!renderer) return
    setErr(null)
    writeContract({
      address: edition,
      abi: pndEditionsAbi,
      functionName: "setRenderer",
      args: [renderer],
    })
  }, [renderer, edition, writeContract])

  // Don't surface anything to the public — only the artist manages this. This
  // gate (and the derived consts) must stay below every hook above, or the
  // hook order changes when the wallet connects (isOwner flips false->true).
  if (!isOwner) return null

  const notConfigured = !operator || !renderer
  const isRegistered = registeredOperator === true
  const isAnchored = !!artwork && (artwork as { artistUris: readonly string[] }).artistUris.length > 0
  const isRendererSet = currentRenderer.toLowerCase() === (renderer ?? "").toLowerCase()
  const busy = isPending || mining || preparing

  return (
    <section className="border-b border-border py-5">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center justify-between text-left"
      >
        <span className={LABEL}>Preserve onchain (MURI)</span>
        <span className="font-mono text-[11px] text-fg-subtle">{open ? "−" : "+"}</span>
      </button>

      {open && (
        <div className="mt-3 space-y-3">
          {notConfigured ? (
            <p className={HELP}>
              The MURI operator and renderer are not configured for this network
              yet.
            </p>
          ) : (
            <>
              <p className={HELP}>
                Anchor this edition&rsquo;s artwork onchain via MURI: multiple
                fallback URIs plus a SHA-256 integrity hash, with an onchain
                viewer that shows the first surviving copy. Your tokens keep
                their live Mint Marks, and PND never holds your media.
              </p>

              <div className="space-y-2.5 border border-border bg-surface-muted/40 p-3">
                <Step
                  done={isRegistered}
                  n={1}
                  label="Register this edition with MURI"
                  actionLabel="Register"
                  busy={busy}
                  onAction={register}
                />
                <Step
                  done={isAnchored}
                  n={2}
                  label="Anchor the artwork (fallbacks + hash)"
                  actionLabel={preparing ? "Preparing…" : "Anchor"}
                  busy={busy}
                  disabled={!isRegistered}
                  onAction={() => void anchor()}
                />
                <Step
                  done={isRendererSet}
                  n={3}
                  label="Use the MURI renderer for this edition"
                  actionLabel="Switch renderer"
                  busy={busy}
                  disabled={!isAnchored}
                  onAction={switchRenderer}
                />
              </div>

              {txHash && (
                <p className="text-[10px] font-mono text-fg-subtle">
                  {mining ? "Confirming… " : mined ? "Confirmed. " : "Submitted… "}
                  <a
                    className="underline hover:text-fg"
                    href={getEvmNowTxUrl(txHash)}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    {txHash.slice(0, 10)}…↗
                  </a>
                </p>
              )}
              {err && <p className="text-xs text-red-500 break-words">{err}</p>}
            </>
          )}
        </div>
      )}
    </section>
  )
}

function Step({
  done,
  n,
  label,
  actionLabel,
  onAction,
  busy,
  disabled,
}: {
  done: boolean
  n: number
  label: string
  actionLabel: string
  onAction: () => void
  busy: boolean
  disabled?: boolean
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="flex items-center gap-2 text-xs">
        <span
          className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-[9px] font-mono ${
            done
              ? "bg-status-available text-white"
              : "border border-border-strong text-fg-subtle"
          }`}
        >
          {done ? "✓" : n}
        </span>
        <span className={done ? "text-fg-muted" : "text-fg"}>{label}</span>
      </span>
      {!done && (
        <button onClick={onAction} disabled={busy || disabled} className={BTN}>
          {actionLabel}
        </button>
      )}
    </div>
  )
}
