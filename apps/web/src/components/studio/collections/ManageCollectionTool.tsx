"use client"

/**
 * Studio collection management: the owner-side panels for a deployed
 * collection. Two jobs today:
 *
 * 1. Admins & ownership — who holds keys, the isAdmin checker, and the
 *    warning that matters at transfer time: admin grants SURVIVE
 *    ownership transfer (reaudit notes, Change 1 — accepted by design).
 *    Roster enumeration is indexer-deferred (AdminSet events); until
 *    discovery indexing lands, verify any specific key with the checker.
 * 2. Captures — the backfill flow from docs/pnd-collection-thumbnails.md
 *    §5: for a scripty work, read the renderer's onchain code refs,
 *    render each token client-side, capture the canonical frame, upload
 *    under the artist's own pinning key, and land ONE setCaptures batch
 *    transaction (or set the {id} template directly).
 *
 * RPC posture: everything here is artist-initiated and bounded (one
 * multicall per load, one seed multicall per capture batch); nothing
 * polls, nothing reads per render.
 */

import { useMemo, useState } from "react"
import { isAddress, type Address } from "viem"
import { usePublicClient, useWriteContract, useWaitForTransactionReceipt } from "wagmi"
import { collectionAbi, renderAssetsAbi, scriptyRendererAbi } from "@pin/abi"

import {
  captureTokenPNG,
  chainResolver,
  defaultGunzip,
  CODE_KIND,
  type CodeRefLike,
  type WorkInput,
} from "@/lib/collection-render"
import { renderAssetsAddress, PND_CHAIN_ID } from "@/lib/collection"
import { PinataProvider } from "@/lib/pinning/pinata"

const PINATA_KEY_LS = "cg_pin_key"
const BATCH_CAP = 24 // capture batches stay small: sequential renders in-browser

// One-function ABI slice: multicall over the full collectionAbi sends tsc
// into excessively-deep type instantiation.
const tokenSeedAbi = [
  {
    type: "function",
    name: "tokenSeed",
    stateMutability: "view",
    inputs: [{ name: "tokenId", type: "uint256" }],
    outputs: [{ name: "", type: "bytes32" }],
  },
] as const

const BTN =
  "rounded bg-black px-3 py-1.5 text-xs font-medium text-white disabled:opacity-40 dark:bg-white dark:text-black"
const BTN_2 =
  "rounded border border-gray-300 px-3 py-1.5 text-xs font-medium disabled:opacity-40"
const INPUT = "w-full rounded border border-gray-200 px-2 py-1 text-xs font-mono"

type Loaded = {
  address: Address
  name: string
  owner: Address
  minted: bigint
  renderer: Address
  cover: string
  template: string
}

export function ManageCollectionTool() {
  const client = usePublicClient()
  const assets = renderAssetsAddress(PND_CHAIN_ID)

  const [addrInput, setAddrInput] = useState("")
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const load = async () => {
    if (!client || !isAddress(addrInput)) return
    setBusy(true)
    setLoadError(null)
    setLoaded(null)
    try {
      const address = addrInput as Address
      const base = { address, abi: collectionAbi } as const
      const [name, owner, cfg, renderer] = await Promise.all([
        client.readContract({ ...base, functionName: "name" }),
        client.readContract({ ...base, functionName: "owner" }),
        client.readContract({ ...base, functionName: "config" }),
        client.readContract({ ...base, functionName: "renderer" }),
      ])
      const [cover, template] = assets
        ? await Promise.all([
            client.readContract({ address: assets, abi: renderAssetsAbi, functionName: "coverOf", args: [address] }),
            client.readContract({
              address: assets,
              abi: renderAssetsAbi,
              functionName: "templateOf",
              args: [address],
            }),
          ])
        : ["", ""]
      setLoaded({
        address,
        name,
        owner,
        minted: cfg[2],
        renderer,
        cover: cover as string,
        template: template as string,
      })
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex gap-2">
        <input
          value={addrInput}
          onChange={(e) => setAddrInput(e.target.value.trim())}
          placeholder="Collection address (0x…)"
          className={INPUT}
        />
        <button onClick={load} disabled={busy || !isAddress(addrInput) || !client} className={BTN}>
          {busy ? "Loading…" : "Load"}
        </button>
      </div>
      {loadError && <p className="text-xs text-red-600">{loadError}</p>}

      {loaded && (
        <>
          <header className="space-y-0.5">
            <h3 className="text-sm font-medium">{loaded.name}</h3>
            <p className="text-xs text-gray-500">
              {Number(loaded.minted)} minted · owner <span className="font-mono">{loaded.owner}</span>
            </p>
          </header>
          <AdminsPanel collection={loaded} />
          {assets && <CapturesPanel collection={loaded} assets={assets} />}
        </>
      )}
    </div>
  )
}

// ── Admins & ownership ──────────────────────────────────────────────────────

function AdminsPanel({ collection }: { collection: Loaded }) {
  const client = usePublicClient()
  const [check, setCheck] = useState("")
  const [verdict, setVerdict] = useState<string | null>(null)

  const runCheck = async () => {
    if (!client || !isAddress(check)) return
    setVerdict(null)
    const yes = await client.readContract({
      address: collection.address,
      abi: collectionAbi,
      functionName: "isAdmin",
      args: [check as Address],
    })
    setVerdict(yes ? "yes — this key can use every management function" : "no — this key holds nothing")
  }

  return (
    <section className="space-y-2 rounded border border-gray-200 p-3">
      <h4 className="text-xs font-medium">Admins &amp; ownership</h4>
      <p className="text-[11px] leading-relaxed text-amber-700 dark:text-amber-500">
        Admin grants survive an ownership transfer. If this collection changes hands, every
        previously granted admin keeps full access — windows, prices, renderer, minters, payout —
        until the new owner revokes them one by one. Before transferring (or accepting) a
        collection, verify exactly who still holds keys.
      </p>
      <p className="text-[11px] leading-relaxed text-gray-500">
        The full grant history becomes listable here once discovery indexing lands (AdminSet
        events). Until then, check any specific key:
      </p>
      <div className="flex gap-2">
        <input
          value={check}
          onChange={(e) => {
            setCheck(e.target.value.trim())
            setVerdict(null)
          }}
          placeholder="Is this address an admin? (0x…)"
          className={INPUT}
        />
        <button onClick={runCheck} disabled={!isAddress(check)} className={BTN_2}>
          Check
        </button>
      </div>
      {verdict && <p className="text-[11px] text-gray-700 dark:text-gray-300">{verdict}</p>}
    </section>
  )
}

// ── Captures (the backfill flow) ────────────────────────────────────────────

type CaptureRow = { tokenId: bigint; uri: string }

function CapturesPanel({ collection, assets }: { collection: Loaded; assets: Address }) {
  const client = usePublicClient()
  const [jwt, setJwt] = useState(() =>
    typeof window === "undefined" ? "" : (localStorage.getItem(PINATA_KEY_LS) ?? ""),
  )
  const [from, setFrom] = useState("1")
  const [to, setTo] = useState(String(Math.min(Number(collection.minted), BATCH_CAP)))
  const [progress, setProgress] = useState<string | null>(null)
  const [rows, setRows] = useState<CaptureRow[]>([])
  const [error, setError] = useState<string | null>(null)
  const [templateInput, setTemplateInput] = useState(collection.template)

  const write = useWriteContract()
  const receipt = useWaitForTransactionReceipt({ hash: write.data })

  const gunzip = useMemo(() => defaultGunzip(PND_CHAIN_ID), [])

  const runBatch = async () => {
    if (!client || !jwt) return
    setError(null)
    setRows([])
    try {
      const first = BigInt(from)
      const last = BigInt(to)
      if (last < first || last - first + 1n > BigInt(BATCH_CAP)) {
        throw new Error(`batch must be 1–${BATCH_CAP} tokens`)
      }

      // The work definition lives on the renderer (scripty template views).
      setProgress("reading the renderer's work refs…")
      const rBase = { address: collection.renderer, abi: scriptyRendererAbi } as const
      const [code, deps, injectionVersion] = await Promise.all([
        client.readContract({ ...rBase, functionName: "code" }),
        client.readContract({ ...rBase, functionName: "deps" }),
        client.readContract({ ...rBase, functionName: "injectionVersion" }),
      ]).catch(() => {
        throw new Error(
          "this collection's renderer doesn't expose scripty work refs (code/deps); captures apply to script-based works — SVG works render their image onchain",
        )
      })
      const work: WorkInput = {
        code: code.map((c) => ({ store: c.store, name: c.name, kind: c.kind as CodeRefLike["kind"] })),
        deps: deps.map((d) => ({ store: d.store, name: d.name, kind: d.kind as CodeRefLike["kind"] })),
        injectionVersion: Number(injectionVersion),
      }
      if (work.code.some((c) => c.kind !== CODE_KIND.Script && c.kind !== CODE_KIND.ScriptGzip)) {
        throw new Error("unsupported code kind in work refs")
      }

      // One multicall for the seeds, then capture + upload sequentially.
      const ids: bigint[] = []
      for (let id = first; id <= last; id++) ids.push(id)
      setProgress("reading seeds…")
      const seeds = await client.multicall({
        contracts: ids.map((id) => ({
          address: collection.address,
          abi: tokenSeedAbi,
          functionName: "tokenSeed" as const,
          args: [id] as const,
        })),
        allowFailure: true,
      })

      const resolver = chainResolver(client)
      const provider = new PinataProvider(jwt)
      const done: CaptureRow[] = []
      for (let i = 0; i < ids.length; i++) {
        const seed = seeds[i]
        if (seed.status !== "success") continue // unminted id: skip
        setProgress(`token ${ids[i]}: rendering + capturing…`)
        const png = await captureTokenPNG(
          work,
          {
            hash: seed.result,
            tokenId: ids[i].toString(),
            collection: collection.address.toLowerCase(),
            chainId: PND_CHAIN_ID,
            version: work.injectionVersion,
          },
          resolver,
          gunzip,
        )
        setProgress(`token ${ids[i]}: uploading…`)
        const file = new File([png], `${ids[i]}.png`, { type: "image/png" })
        const { cid } = await provider.uploadFile(file, file.name)
        done.push({ tokenId: ids[i], uri: `ipfs://${cid}` })
        setRows([...done])
      }
      localStorage.setItem(PINATA_KEY_LS, jwt)
      setProgress(
        done.length > 0
          ? `${done.length} frame(s) captured and uploaded — land them with one transaction below`
          : "no minted tokens in that range",
      )
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setProgress(null)
    }
  }

  const landCaptures = () => {
    write.writeContract({
      address: assets,
      abi: renderAssetsAbi,
      functionName: "setCaptures",
      args: [collection.address, rows.map((r) => r.tokenId), rows.map((r) => r.uri)],
    })
  }

  const landTemplate = () => {
    write.writeContract({
      address: assets,
      abi: renderAssetsAbi,
      functionName: "setCaptureTemplate",
      args: [collection.address, templateInput.trim()],
    })
  }

  return (
    <section className="space-y-3 rounded border border-gray-200 p-3">
      <h4 className="text-xs font-medium">Captures</h4>
      <p className="text-[11px] leading-relaxed text-gray-500">
        Marketplace grids show each token&apos;s <span className="font-mono">image</span>. Cover
        today: <span className="font-mono">{collection.cover || "(none)"}</span>. Frames are
        captured in your browser per the canonical spec and uploaded under your own pinning key;
        one transaction lands the batch. For whole-drop refreshes prefer the{" "}
        <span className="font-mono">{"{id}"}</span> template (one small transaction, any size).
      </p>

      <input
        type="password"
        value={jwt}
        onChange={(e) => setJwt(e.target.value.trim())}
        placeholder="Pinata JWT (yours; stored in this browser only)"
        className={INPUT}
      />

      <div className="flex items-center gap-2">
        <span className="text-[11px] text-gray-500">tokens</span>
        <input value={from} onChange={(e) => setFrom(e.target.value)} className={`${INPUT} w-20`} />
        <span className="text-[11px] text-gray-500">to</span>
        <input value={to} onChange={(e) => setTo(e.target.value)} className={`${INPUT} w-20`} />
        <button onClick={runBatch} disabled={!jwt || !client} className={BTN_2}>
          Capture batch
        </button>
      </div>

      {progress && <p className="text-[11px] text-gray-700 dark:text-gray-300">{progress}</p>}
      {error && <p className="text-[11px] text-red-600">{error}</p>}

      {rows.length > 0 && (
        <button onClick={landCaptures} disabled={write.isPending || receipt.isLoading} className={BTN}>
          {write.isPending || receipt.isLoading
            ? "Landing…"
            : `Set ${rows.length} capture(s) — one transaction`}
        </button>
      )}

      <div className="flex items-center gap-2 border-t border-gray-100 pt-2">
        <input
          value={templateInput}
          onChange={(e) => setTemplateInput(e.target.value)}
          placeholder="Capture template, e.g. ar://<manifest>/{id}.png"
          className={INPUT}
        />
        <button onClick={landTemplate} disabled={write.isPending || receipt.isLoading} className={BTN_2}>
          Set template
        </button>
      </div>

      {receipt.isSuccess && (
        <p className="text-[11px] text-green-700">
          Landed. Nudge marketplaces with notifyMetadataUpdate (owner/admin) if you want an
          immediate refresh.
        </p>
      )}
      {write.error && <p className="text-[11px] text-red-600">{write.error.message.split("\n")[0]}</p>}
    </section>
  )
}
