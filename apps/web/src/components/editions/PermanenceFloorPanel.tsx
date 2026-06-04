"use client"

/**
 * Phase 2 of mint-funded permanence (docs/editions-permanence-funding.md): the
 * owner action that CLOSES THE LOOP. It spends the work's permanence vault on a
 * pay-once Arweave copy via the Irys rail, then registers the copy's URIs as
 * MURI fallbacks (addArtworkUris under the canonical id 0) so they compose with
 * the existing anchor + renderer + honest-status badge. The durability is
 * EARNED: "permanent floor" only once arweave.net resolves, else honest
 * "irys-stored".
 *
 * Sovereign + non-custodial: the upload is paid and signed by the artist's own
 * wallet (funded from their vault), the bytes go wallet→Irys, PND holds nothing.
 *
 * RPC discipline: renders + reads nothing for non-owners. Even for the owner,
 * the single MURI status read fires only after they expand the panel.
 */

import { useCallback, useEffect, useState } from "react"
import {
  useAccount,
  usePublicClient,
  useReadContract,
  useWaitForTransactionReceipt,
  useWalletClient,
  useWriteContract,
} from "wagmi"
import type { Address } from "viem"
import { muriProtocolAbi } from "@pin/abi"
import { ipfsToHttp } from "@pin/shared"
import { muriProtocolAddress } from "@/lib/pnd-editions"
import { irysArweaveRail } from "@/lib/editions-rail-irys"
import { formatWriteError } from "@/components/tx/tx-ui"
import { PermanenceFloorStatus, type FloorState } from "./PermanenceFloorStatus"

const CANONICAL_TOKEN_ID = 0n
const LABEL = "text-[10px] font-mono uppercase tracking-[0.1em] text-fg-subtle"

type Phase = "idle" | "uploading" | "registering" | "done" | "error"

type Props = {
  edition: Address
  owner: Address
  artworkURI: string
  chainId: number
}

export function PermanenceFloorPanel(props: Props) {
  const [mounted, setMounted] = useState(false)
  useEffect(() => setMounted(true), [])
  if (!mounted) return null
  return <PermanenceFloorPanelInner {...props} />
}

function PermanenceFloorPanelInner({ edition, owner, artworkURI, chainId }: Props) {
  const { address } = useAccount()
  const isOwner = !!address && address.toLowerCase() === owner.toLowerCase()
  const muri = muriProtocolAddress()

  const [open, setOpen] = useState(false)
  const [phase, setPhase] = useState<Phase>("idle")
  const [err, setErr] = useState<string | null>(null)
  const [arweaveUri, setArweaveUri] = useState<string | undefined>()
  const [earned, setEarned] = useState<"permanent-floor" | "irys-stored" | undefined>()

  const { data: walletClient } = useWalletClient()
  const publicClient = usePublicClient()
  const { writeContract, data: txHash, error: writeError, reset } = useWriteContract()
  const { isSuccess: mined } = useWaitForTransactionReceipt({ hash: txHash })

  // Owner-only, on-expand: is the edition anchored in MURI? addArtworkUris needs
  // the canonical token initialized (the anchor step), so we gate on it.
  const { data: artwork } = useReadContract({
    address: muri,
    abi: muriProtocolAbi,
    functionName: "getArtwork",
    args: [edition, CANONICAL_TOKEN_ID],
    query: { enabled: open && isOwner },
  })
  const anchored = !!artwork && (artwork as { artistUris: readonly string[] }).artistUris.length > 0

  useEffect(() => {
    if (mined && phase === "registering") setPhase("done")
  }, [mined, phase])

  const onFund = useCallback(async () => {
    setErr(null)
    if (!walletClient || !publicClient) {
      setErr("Connect your wallet to fund a floor copy.")
      return
    }
    try {
      setPhase("uploading")
      // Re-fetch the artwork bytes and upload a durable Arweave copy via the rail.
      const res = await fetch(ipfsToHttp(artworkURI))
      if (!res.ok) throw new Error(`Could not fetch the artwork to copy it (${res.status}).`)
      const blob = await res.blob()
      const file = new File([blob], "artwork", {
        type: blob.type || "application/octet-stream",
      })
      const result = await irysArweaveRail.fund({ file, walletClient, publicClient })
      setArweaveUri(result.uris[0])
      setEarned(result.durability === "permanent-floor" ? "permanent-floor" : "irys-stored")
      // Register the durable copy's URIs as MURI fallbacks (artist-signed).
      setPhase("registering")
      writeContract({
        address: muri,
        abi: muriProtocolAbi,
        functionName: "addArtworkUris",
        args: [edition, CANONICAL_TOKEN_ID, result.uris],
      })
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed to fund the floor copy.")
      setPhase("error")
    }
  }, [walletClient, publicClient, artworkURI, edition, muri, writeContract])

  if (!isOwner) return null

  const state: FloorState =
    phase === "error"
      ? "error"
      : phase === "done"
        ? earned === "permanent-floor"
          ? "floored"
          : "irys-stored"
        : phase === "uploading"
          ? "uploading"
          : phase === "registering"
            ? "registering"
            : open && !anchored
              ? "needs-anchor"
              : "idle"

  const busy = phase === "uploading" || phase === "registering"

  return (
    <section className="border-b border-border py-5">
      <button
        onClick={() => {
          setOpen((o) => !o)
          if (phase === "error") {
            setPhase("idle")
            reset()
          }
        }}
        className="flex w-full items-center justify-between text-left"
      >
        <span className={LABEL}>Fund a permanent floor (Arweave + MURI)</span>
        <span className="font-mono text-[11px] text-fg-subtle">{open ? "−" : "+"}</span>
      </button>

      {open && (
        <div className="mt-3">
          <PermanenceFloorStatus
            state={state}
            arweaveUri={arweaveUri}
            txHash={txHash}
            error={err ?? (writeError ? formatWriteError(writeError, "Register") : undefined)}
            chainId={chainId}
            onFund={onFund}
            busy={busy}
          />
        </div>
      )}
    </section>
  )
}
