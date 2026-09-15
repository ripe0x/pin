"use client"

/**
 * Step 4: review every value, then a single createSurface write on
 * SurfaceFactory. createSurface takes the token's SurfaceConfig
 * (identity/renderer/royalty/cap/locks) and a separate SaleConfig the
 * factory hands to the canonical FixedPriceMinter clone it wires in the
 * same transaction. The renderer is always the artist's own address from
 * step 1 — no DefaultRenderer fallback, no preset branching.
 *
 * The cover write fires as soon as the collection address is known, so it
 * is not a second step an artist can skip: SuccessScreen only renders once
 * `coverSettled`, and the button below is a manual retry for when the
 * automatic write errors or the wallet prompt is dismissed.
 *
 * SuccessScreen also calls the renderer's previewURI once, against the real
 * deployed collection address: previewURI reads the collection's own onchain
 * state (see ScriptyRenderer.previewURI), so it cannot resolve before the
 * collection exists — this is the first point the wizard can call it.
 */

import { useEffect, useRef, useState } from "react"
import { type Address } from "viem"
import {
  useAccount,
  useChainId,
  usePublicClient,
  useWriteContract,
  useWaitForTransactionReceipt,
} from "wagmi"
import { surfaceFactoryAbi, surfaceFactoryV2Abi, renderAssetsAbi, iPreviewRendererAbi } from "@pin/abi"
import { formatWriteError } from "@/components/tx/tx-ui"
import {
  ZERO_ADDRESS,
  surfaceFactory,
  surfaceFactoryV2,
  renderAssetsAddress,
  ipfsToHttp,
} from "@/lib/collection"
import { buildReviewSummary, decodePreviewURI, isValidArtworkURI, type PreviewDecodeResult } from "@/lib/create-collection"
import { studioToolHref } from "@/lib/studio-tools"
import { parseDeployedCollectionAddress } from "./parse-deployed-address"
import { validateCollaborators } from "./SharedFields"
import type { UseEthAmountInputResult } from "@/lib/useEthAmountInput"
import type { WizardState } from "./types"
import { BTN, BTN_SECONDARY, ERROR, HELP } from "./wizard-ui"

function randomSeed(): `0x${string}` {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  return `0x${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`
}

const ZERO_ROOT = ("0x" + "0".repeat(64)) as `0x${string}`

export function DeployStep({
  state,
  artistAddress,
  price,
  onBack,
  ownerOverride,
  maxMints,
  hideSummary,
}: {
  state: WizardState
  artistAddress: string
  price: UseEthAmountInputResult
  onBack: () => void
  /** Advanced override for the collection's owner arg (e.g. a Safe the
   *  artist wants to own the collection instead of their signing EOA).
   *  Defaults to the connected wallet — the common case, and the only
   *  option the studio wizard exposes today. */
  ownerOverride?: Address
  /** The minter's own sale ceiling, set in the same transaction that wires
   *  the minter. 0 (the default) is unlimited, which is only safe when the
   *  collection carries a supply cap or a mint window bounds the sale. */
  maxMints?: bigint
  /** Skips this step's own field-by-field summary table. Set by callers
   *  (SeededDeployWizard) that already render their own review card above
   *  this step, so the same values aren't listed twice. */
  hideSummary?: boolean
}) {
  const { address } = useAccount()
  const chainId = useChainId()
  // v2 factory wins when it resolves for this chain (art-only core, no
  // pooled mode); v1 is the fallback until v2 deploys. See
  // docs/pnd-surface-v2-plan.md.
  const factoryV2 = surfaceFactoryV2(chainId)
  const factoryV1 = surfaceFactory(chainId)
  const factory = factoryV2 ?? factoryV1
  const renderAssets = renderAssetsAddress(chainId)
  const priceWei = price.wei ?? 0n

  const deploy = useWriteContract()
  const { data: receipt, isLoading: mining } = useWaitForTransactionReceipt({
    hash: deploy.data,
  })

  const deployedAddress = parseDeployedCollectionAddress(receipt, !!factoryV2)

  // Post-deploy configuration: presentation data lives in renderer-land. A
  // cover image goes to RenderAssets, its own tx, authorized by the
  // collection owner (the connected artist).
  const coverWrite = useWriteContract()
  const { isLoading: coverMining, isSuccess: coverDone } = useWaitForTransactionReceipt({
    hash: coverWrite.data,
  })

  const needsCover = state.artworkURI.trim().length > 0
  const coverSettled = !needsCover || coverDone

  // Fires the cover write as soon as the collection exists, rather than
  // waiting for a manual click, so an artist can't leave the deploy step
  // before the cover lands. `firedFor` (not the write's own pending/data
  // state) is the guard: React 18 StrictMode's dev double-invoke re-runs
  // this effect immediately on mount, and the write's own state hasn't
  // committed yet on that second call, so it would fire twice without a
  // ref tracking which collection address already got a write.
  const firedFor = useRef<Address | null>(null)
  useEffect(() => {
    if (!deployedAddress || !needsCover || !renderAssets) return
    if (firedFor.current === deployedAddress) return
    firedFor.current = deployedAddress
    coverWrite.writeContract({
      address: renderAssets,
      abi: renderAssetsAbi,
      functionName: "setCover",
      args: [deployedAddress, state.artworkURI.trim()],
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deployedAddress, needsCover, renderAssets])

  function toUnix(local: string): bigint {
    if (!local) return 0n
    const ms = new Date(local).getTime()
    return Number.isNaN(ms) ? 0n : BigInt(Math.floor(ms / 1000))
  }

  const royaltyBps = Math.round(Number(state.royaltyPct || "0") * 100)
  const collabCheck = validateCollaborators(state.collaborators)

  function buildCfg() {
    return {
      supplyCap: state.openSupply ? 0n : BigInt(Math.floor(Number(state.supplyCap))),
      royaltyBps,
      royaltyReceiver: ZERO_ADDRESS as Address,
      renderer: state.rendererAddress as Address,
      // The two one-way locks default off; the wizard doesn't offer
      // born-locked.
      rendererLocked: false,
      supplyLocked: false,
    }
  }

  function buildSaleBase() {
    return {
      price: priceWei,
      mintStart: state.hasWindow ? toUnix(state.startAt) : 0n,
      mintEnd: state.hasWindow ? toUnix(state.endAt) : 0n,
      payoutRecipient: (state.payout !== "" ? state.payout : ZERO_ADDRESS) as Address,
      maxMints: maxMints ?? 0n,
      allowlistRoot: ZERO_ROOT,
      walletCap: 0n,
    }
  }

  const artworkOk = state.artworkURI.trim() === "" || isValidArtworkURI(state.artworkURI)

  const canDeploy = !!factory && !!address && !!state.rendererAddress && artworkOk

  function submit() {
    if (!canDeploy || !factory || !address) return
    const creators = collabCheck.ok ? collabCheck.parsed : []
    const owner = ownerOverride ?? address
    const name = state.name.trim()
    const symbol = state.symbol.trim()
    const cfg = buildCfg()
    if (factoryV2) {
      // v2's SaleConfig drops priceStrategy (FixedPriceMinterV2 is
      // exact-payment only). seedSource is init-only with no wizard UI (see
      // docs/pnd-surface-v2-plan.md): every wizard-deployed v2 collection
      // derives its own seeds.
      deploy.writeContract({
        address: factoryV2,
        abi: surfaceFactoryV2Abi,
        functionName: "createSurface",
        args: [name, symbol, owner, cfg, buildSaleBase(), creators, ZERO_ADDRESS as Address],
      })
      return
    }
    deploy.writeContract({
      address: factory,
      abi: surfaceFactoryAbi,
      functionName: "createSurface",
      args: [
        name,
        symbol,
        owner,
        cfg,
        { ...buildSaleBase(), priceStrategy: ZERO_ADDRESS as Address },
        creators,
      ],
    })
  }

  if (deployedAddress && coverSettled) {
    return (
      <SuccessScreen
        collection={deployedAddress}
        artistAddress={artistAddress}
        renderer={state.rendererAddress as Address}
      />
    )
  }

  if (deployedAddress) {
    return (
      <div className="space-y-4">
        <p className="text-[11px] font-mono text-gray-500">
          Collection deployed at {deployedAddress}. Publishing its cover image
          to RenderAssets (stored in renderer-land, owned by you):
        </p>
        {needsCover && !coverDone && renderAssets && coverWrite.error && (
          <button
            className={BTN}
            disabled={coverMining || coverWrite.isPending}
            onClick={() =>
              coverWrite.writeContract({
                address: renderAssets,
                abi: renderAssetsAbi,
                functionName: "setCover",
                args: [deployedAddress, state.artworkURI.trim()],
              })
            }
          >
            Set cover image
          </button>
        )}
        {needsCover && !coverDone && renderAssets && !coverWrite.error && (
          <p className="text-[11px] font-mono text-gray-500">
            {coverWrite.isPending
              ? "Confirm the cover image transaction in your wallet…"
              : "Setting cover image…"}
          </p>
        )}
        {needsCover && !coverDone && !renderAssets && (
          <p className="text-[11px] font-mono text-gray-500">
            Cover image publishing isn&rsquo;t live yet. You can set it later once
            RenderAssets deploys.
          </p>
        )}
        {coverWrite.error && (
          <p className={ERROR}>{formatWriteError(coverWrite.error, "Publish")}</p>
        )}
      </div>
    )
  }

  const busy = deploy.isPending || mining
  const summary = buildReviewSummary(state, price.rawValue)

  return (
    <div className="space-y-4">
      <header className="space-y-1.5">
        <h3 className="text-sm font-medium">Review and deploy</h3>
        <p className="text-xs text-gray-500 leading-relaxed">
          One transaction deploys an immutable contract configured with everything
          below: no proxy admin, no upgrade path.
        </p>
      </header>

      {!hideSummary && (
        <dl className="divide-y divide-gray-200 rounded border border-gray-200 text-xs">
          {summary.map((row) => (
            <div key={row.label} className="flex items-baseline justify-between gap-4 px-3 py-2">
              <dt className="text-[10px] font-mono uppercase tracking-wider text-gray-400">
                {row.label}
              </dt>
              <dd className="truncate text-right font-mono">{row.value}</dd>
            </div>
          ))}
        </dl>
      )}

      {!factory && (
        <p className={ERROR}>No CollectionFactory is configured for this network.</p>
      )}
      {!artworkOk && <p className={ERROR}>Cover image URI must start with ipfs://, ar://, or https://</p>}

      <button onClick={submit} disabled={!canDeploy || busy} className={BTN}>
        {deploy.isPending ? "Confirm in wallet…" : mining ? "Deploying…" : "Deploy collection"}
      </button>

      {deploy.error && <p className={ERROR}>{formatWriteError(deploy.error, "Deploy")}</p>}

      <button onClick={onBack} disabled={busy} className={BTN_SECONDARY}>
        Back
      </button>
    </div>
  )
}

const PREVIEW_TOKEN_ID = 1n

type PreviewState = "checking" | "unsupported" | { kind: "found"; preview: PreviewDecodeResult }

function SuccessScreen({
  collection,
  artistAddress,
  renderer,
}: {
  collection: Address
  artistAddress: string
  renderer: Address
}) {
  const publicClient = usePublicClient()
  const [preview, setPreview] = useState<PreviewState>("checking")

  // A plain read (no side effects, no gas), so — unlike the cover write's
  // firedFor ref above — this only needs the standard cleanup-flag guard:
  // React 18 StrictMode's dev double-invoke discards the first run's result
  // via `cancelled` and lets the second run's setPreview land normally. A
  // ref-based fire-once guard here would instead block the SURVIVING second
  // run while the discarded first run's result never lands — no update at
  // all.
  useEffect(() => {
    if (!publicClient) return
    let cancelled = false
    void (async () => {
      try {
        const uri = await publicClient.readContract({
          address: renderer,
          abi: iPreviewRendererAbi,
          functionName: "previewURI",
          args: [collection, PREVIEW_TOKEN_ID, randomSeed()],
        })
        if (!cancelled) setPreview({ kind: "found", preview: decodePreviewURI(uri) })
      } catch {
        // No previewURI on this renderer, or it reverted for this collection.
        if (!cancelled) setPreview("unsupported")
      }
    })()
    return () => {
      cancelled = true
    }
  }, [publicClient, collection, renderer])

  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-green-200 bg-green-50 p-5 space-y-2">
        <p className="text-sm font-medium text-green-800">Collection deployed</p>
        <p className="text-xs font-mono text-green-700 break-all">{collection}</p>
      </div>

      <PreviewCard state={preview} />

      <a
        href={`/collections/${collection}`}
        className="block text-center text-[11px] font-mono font-medium uppercase tracking-wider py-3 bg-fg text-bg hover:opacity-80 transition-colors"
      >
        View collection
      </a>
      <a
        href={`/collections/${collection}#mint-instrument`}
        className="block text-center text-[11px] font-mono font-medium uppercase tracking-wider px-4 py-2 border border-gray-200 hover:border-gray-400 transition-colors"
      >
        Open mint control
      </a>
      <a
        href={`${studioToolHref(artistAddress, "collections")}?collection=${collection}`}
        className="block text-center text-[11px] font-mono font-medium uppercase tracking-wider px-4 py-2 border border-gray-200 hover:border-gray-400 transition-colors"
      >
        Collection settings
      </a>
    </div>
  )
}

function PreviewCard({ state }: { state: PreviewState }) {
  if (state === "checking") return null
  if (state === "unsupported") {
    return <p className={HELP}>This renderer has no preview call. Mint one token to see the work.</p>
  }
  const { preview } = state
  if (preview.kind === "unsupported") {
    return <p className={HELP}>This renderer has no preview call. Mint one token to see the work.</p>
  }
  return (
    <div className="space-y-1.5">
      <p className="text-sm font-medium">One seed from your renderer</p>
      <p className="text-xs text-gray-500 leading-relaxed">
        Token images render from this contract when minted.
      </p>
      <div className="aspect-square w-full max-w-xs overflow-hidden rounded border border-gray-200 bg-surface-muted">
        {preview.kind === "html" ? (
          <iframe
            sandbox="allow-scripts"
            srcDoc={preview.html}
            title="One seed from your renderer"
            className="h-full w-full border-0"
          />
        ) : (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={ipfsToHttp(preview.src)}
            alt="One seed from your renderer"
            className="h-full w-full object-contain"
          />
        )}
      </div>
    </div>
  )
}
