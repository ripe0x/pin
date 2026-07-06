"use client"

/**
 * The GENERATIVE preset's upload step: writes the artist's raw JS script to
 * ScriptyStorageV2 in ~15000-byte chunks, one wagmi write per chunk.
 *
 * Name scheme: `pnd-<artist>-<slug>-v<n>` (create-collection.ts contentName).
 * Namespaced per artist so two artists can reuse a title. Existence
 * pre-check reads contents(name).owner: a non-zero owner means the name is
 * taken (by this artist's own earlier attempt, or in the pathological case
 * someone else's content landed on the same slug+version) — the resolver
 * bumps the version suffix until it finds a free name, never overwriting.
 *
 * Resume: chunk upload progress is tracked purely by count (chunksUploaded,
 * held in the wizard's in-memory state) against the deterministic chunk
 * list computed from the same script text, so a failed or abandoned chunk
 * write can be retried/picked up from the last confirmed index within the
 * same wizard session rather than re-uploading everything from scratch.
 * This is a local, in-memory resume only — it does not survive a page
 * reload (the wizard holds no state outside React), and it is not
 * chain-verified against `contents(name).size`. If the artist edits the
 * script after a partial upload, the chunk list changes and the count
 * resets to 0 via the useEffect below.
 */

import { useEffect, useState } from "react"
import type { Address } from "viem"
import {
  usePublicClient,
  useAccount,
  useChainId,
  useWriteContract,
  useWaitForTransactionReceipt,
} from "wagmi"
import { scriptyStorageAbi } from "@pin/abi"
import { SCRIPTY_STORAGE_V2, getAddressOrNull } from "@pin/addresses"
import { formatWriteError } from "@/components/tx/tx-ui"
import {
  chunkScript,
  contentName,
  scriptBytes,
  scriptCodeHash,
  slugify,
  toHexChunk,
} from "@/lib/create-collection"
import type { WizardState } from "./types"
import { BTN, BTN_SECONDARY, ERROR, HELP } from "./wizard-ui"

export function UploadStep({
  state,
  set,
  onBack,
  onNext,
}: {
  state: WizardState
  set: <K extends keyof WizardState>(key: K, value: WizardState[K]) => void
  onBack: () => void
  onNext: (args: { name: string; codeHash: `0x${string}` }) => void
}) {
  const { address } = useAccount()
  const publicClient = usePublicClient()
  const chainId = useChainId()
  const storage = getAddressOrNull(SCRIPTY_STORAGE_V2, chainId)

  const bytes = scriptBytes(state.script)
  const chunks = chunkScript(bytes)
  const codeHash = scriptCodeHash(bytes)

  const [resolvedName, setResolvedName] = useState<string | null>(state.contentNameChosen)
  const [checking, setChecking] = useState(false)
  const [checkError, setCheckError] = useState<string | null>(null)
  const [createDone, setCreateDone] = useState(false)

  // Script content changed since a previous partial upload: the chunk list
  // no longer matches what's already on chain, so reset resume state.
  useEffect(() => {
    if (state.chunksUploaded > 0 && state.totalChunks !== chunks.length) {
      set("chunksUploaded", 0)
      set("totalChunks", chunks.length)
    } else if (state.totalChunks !== chunks.length) {
      set("totalChunks", chunks.length)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chunks.length])

  const create = useWriteContract()
  const chunk = useWriteContract()
  const { isLoading: createMining, data: createReceipt } = useWaitForTransactionReceipt({
    hash: create.data,
  })
  const { isLoading: chunkMining, data: chunkReceipt } = useWaitForTransactionReceipt({
    hash: chunk.data,
  })

  // Existence pre-check: find a free content name, bumping the version
  // suffix on collision. Runs once per (address, name) pair.
  useEffect(() => {
    if (!address || !publicClient || !storage) return
    if (resolvedName) return
    let cancelled = false
    setChecking(true)
    setCheckError(null)
    const slug = slugify(state.name)
    async function resolve() {
      for (let v = 1; v <= 50; v++) {
        const candidate = contentName(address as Address, slug, v)
        try {
          const result = await publicClient!.readContract({
            address: storage as Address,
            abi: scriptyStorageAbi,
            functionName: "contents",
            args: [candidate],
          })
          const owner = (result as readonly [boolean, Address, bigint])[1]
          const taken = owner !== "0x0000000000000000000000000000000000000000"
          if (!taken) {
            if (!cancelled) {
              setResolvedName(candidate)
              set("contentNameChosen", candidate)
              setChecking(false)
            }
            return
          }
        } catch {
          // Treat a read failure as "unknown, try the next candidate" rather
          // than blocking the whole flow on an RPC hiccup.
        }
      }
      if (!cancelled) {
        setCheckError("Could not find a free content name after 50 attempts.")
        setChecking(false)
      }
    }
    void resolve()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [address, publicClient, storage, resolvedName])

  // createContent confirmed -> start chunk uploads (or skip straight to
  // chunks if resuming an already-created name).
  useEffect(() => {
    if (createReceipt) setCreateDone(true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [createReceipt])

  // A chunk write confirmed -> advance the resume counter.
  useEffect(() => {
    if (!chunkReceipt) return
    set("chunksUploaded", state.chunksUploaded + 1)
    chunk.reset()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chunkReceipt])

  function startCreate() {
    if (!storage || !resolvedName) return
    create.writeContract({
      address: storage,
      abi: scriptyStorageAbi,
      functionName: "createContent",
      args: [resolvedName, "0x"],
    })
  }

  function uploadNextChunk() {
    if (!storage || !resolvedName) return
    const idx = state.chunksUploaded
    if (idx >= chunks.length) return
    chunk.writeContract({
      address: storage,
      abi: scriptyStorageAbi,
      functionName: "addChunkToContent",
      args: [resolvedName, toHexChunk(chunks[idx])],
    })
  }

  const allChunksDone = state.chunksUploaded >= chunks.length
  const busy = create.isPending || createMining || chunk.isPending || chunkMining
  const writeError = create.error ?? chunk.error

  if (!storage) {
    return (
      <div className="space-y-4">
        <p className={ERROR}>ScriptyStorageV2 is not configured for this network.</p>
        <button onClick={onBack} className={BTN_SECONDARY}>
          Back
        </button>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <header className="space-y-1.5">
        <h3 className="text-sm font-medium">Upload script onchain</h3>
        <p className="text-xs text-gray-500 leading-relaxed">
          Stored as raw JavaScript in ScriptyStorageV2, in {chunks.length} chunk
          {chunks.length === 1 ? "" : "s"}. Each chunk is its own transaction.
        </p>
      </header>

      {checking && <p className={HELP}>Checking for a free content name…</p>}
      {checkError && <p className={ERROR}>{checkError}</p>}

      {resolvedName && (
        <div className="rounded border border-gray-200 p-3 space-y-1">
          <p className="text-[10px] font-mono text-gray-400 uppercase tracking-wider">
            Content name
          </p>
          <p className="text-xs font-mono break-all">{resolvedName}</p>
        </div>
      )}

      {resolvedName && (
        <div className="space-y-3">
          {!createDone ? (
            <button onClick={startCreate} disabled={busy} className={BTN}>
              {create.isPending
                ? "Confirm in wallet…"
                : createMining
                  ? "Creating content slot…"
                  : "1. Create content slot"}
            </button>
          ) : (
            <div className="space-y-2">
              <div className="h-1.5 w-full rounded-full bg-gray-100 overflow-hidden">
                <div
                  className="h-full bg-fg transition-all"
                  style={{
                    width: `${chunks.length === 0 ? 100 : (state.chunksUploaded / chunks.length) * 100}%`,
                  }}
                />
              </div>
              <p className={HELP}>
                {state.chunksUploaded} / {chunks.length} chunks uploaded
              </p>
              {!allChunksDone ? (
                <button onClick={uploadNextChunk} disabled={busy} className={BTN}>
                  {chunk.isPending
                    ? "Confirm in wallet…"
                    : chunkMining
                      ? "Uploading chunk…"
                      : `Upload chunk ${state.chunksUploaded + 1} of ${chunks.length}`}
                </button>
              ) : (
                <button
                  onClick={() => onNext({ name: resolvedName, codeHash })}
                  className={BTN}
                >
                  Continue to deploy
                </button>
              )}
            </div>
          )}
        </div>
      )}

      {writeError && <p className={ERROR}>{formatWriteError(writeError, "Upload")}</p>}

      <button onClick={onBack} disabled={busy} className={BTN_SECONDARY}>
        Back
      </button>
    </div>
  )
}
