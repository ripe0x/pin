"use client"

/**
 * Final step: a single createSurface write on SurfaceFactory, ported
 * from CreateEditionForm's useWriteContract + useWaitForTransactionReceipt +
 * parseEventLogs pattern. createSurface takes the token's shrunk
 * SurfaceConfig (identity/renderer/royalty/cap; no more price, window,
 * payout, or mint hook — thin-token rearchitecture) and a separate
 * SaleConfig the factory hands to the canonical FixedPriceMinter clone it
 * wires in the same transaction:
 *
 *   EDITION:   Sequential id mode, renderer = zero (DefaultRenderer, the
 *              factory's baked-in default); optional cover to RenderAssets.
 *   RENDERER:  renderer = the artist-supplied address (bring-your-own).
 *
 * Economics (price/window/payout) are preset-independent and now live
 * entirely in `sale`, not the collection config.
 *
 * GENERATIVE via a shared onchain assembler was removed: generative works now
 * ship as bring-your-own renderers (a work-specific IRenderer the artist
 * deploys and points the slot at, i.e. the RENDERER preset). The guided
 * generative deploy flow is being rebuilt on that model, so the wizard blocks
 * a generative deploy here for now.
 */

import { useRouter } from "next/navigation"
import { parseEventLogs, type Address, type TransactionReceipt } from "viem"
import { useAccount, useChainId, useWriteContract, useWaitForTransactionReceipt } from "wagmi"
import { surfaceFactoryAbi, renderAssetsAbi } from "@pin/abi"
import { formatWriteError } from "@/components/tx/tx-ui"
import {
  ZERO_ADDRESS,
  surfaceFactory,
  renderAssetsAddress,
} from "@/lib/collection"
import { studioToolHref } from "@/lib/studio-tools"
import { validateCollaborators } from "./SharedFields"
import type { WizardState } from "./types"
import { BTN, BTN_SECONDARY, ERROR } from "./wizard-ui"

const ZERO_ROOT = ("0x" + "0".repeat(64)) as `0x${string}`

export function DeployStep({
  state,
  artistAddress,
  priceWei,
  onBack,
  ownerOverride,
  maxMints,
}: {
  state: WizardState
  artistAddress: string
  priceWei: bigint
  onBack: () => void
  /** Advanced override for the collection's owner arg (e.g. a Safe the
   *  artist wants to own the collection instead of their signing EOA).
   *  Defaults to the connected wallet — the common case, and the only
   *  option the studio wizard exposes today. */
  ownerOverride?: Address
  /** The minter's own sale ceiling, set in the same transaction that wires
   *  the minter. 0 (the default) is unlimited, which is only safe when the
   *  collection carries a supply cap or a mint window bounds the sale: an
   *  open-supply collection with no window and no ceiling is an unbounded
   *  mint from the moment it deploys. A batched release passes its first
   *  batch size here and raises it per batch afterwards (studio Sale
   *  settings -> setMaxMints). */
  maxMints?: bigint
}) {
  const { address } = useAccount()
  const chainId = useChainId()
  const factory = surfaceFactory(chainId)
  const renderAssets = renderAssetsAddress(chainId)

  const deploy = useWriteContract()
  const { data: receipt, isLoading: mining } = useWaitForTransactionReceipt({
    hash: deploy.data,
  })

  const deployedAddress = useDeployedAddress(receipt)

  // Post-deploy configuration: presentation data lives in renderer-land. A
  // cover image goes to RenderAssets — its own tx, authorized by the
  // collection owner (the connected artist).
  const coverWrite = useWriteContract()
  const { isLoading: coverMining, isSuccess: coverDone } = useWaitForTransactionReceipt({
    hash: coverWrite.data,
  })

  const needsCover = state.artworkURI.trim().length > 0
  const coverSettled = !needsCover || coverDone

  function toUnix(local: string): bigint {
    if (!local) return 0n
    const ms = new Date(local).getTime()
    return Number.isNaN(ms) ? 0n : BigInt(Math.floor(ms / 1000))
  }

  const royaltyBps = Math.round(Number(state.royaltyPct || "0") * 100)
  const collabCheck = validateCollaborators(state.collaborators)

  function buildCfg() {
    const rendererAddr =
      state.preset === "renderer"
        ? (state.customRenderer as Address)
        : (ZERO_ADDRESS as Address)

    // Thin-token rearchitecture: SurfaceConfig carries only the token's own
    // structural facts now (supply cap, royalty, renderer, locks). Sale
    // economics moved to `buildSale` below, wired onto the canonical minter.
    return {
      supplyCap: state.openSupply ? 0n : BigInt(Math.floor(Number(state.supplyCap))),
      royaltyBps,
      royaltyReceiver: ZERO_ADDRESS as Address,
      renderer: rendererAddr,
      // The two one-way locks default off; the wizard doesn't offer
      // born-locked.
      rendererLocked: false,
      supplyLocked: false,
    }
  }

  function buildSale() {
    // Economics are preset-independent: renderer-native works sell through
    // the same canonical minter; only the artwork source differs. The
    // wizard doesn't yet offer allowlist/wallet-cap/priceStrategy at deploy
    // time — those are studio follow-up actions (mint gate tool,
    // ActivationQueue) directly on the minter after deploy. maxMints is the
    // exception: a sale ceiling set after the fact leaves the mint unbounded
    // in between, so callers that need one pass it here.
    return {
      price: priceWei,
      priceStrategy: ZERO_ADDRESS as Address,
      mintStart: state.hasWindow ? toUnix(state.startAt) : 0n,
      mintEnd: state.hasWindow ? toUnix(state.endAt) : 0n,
      payoutRecipient: (state.payout !== "" ? state.payout : ZERO_ADDRESS) as Address,
      maxMints: maxMints ?? 0n,
      allowlistRoot: ZERO_ROOT,
      walletCap: 0n,
    }
  }

  const canDeploy =
    !!factory &&
    !!address &&
    state.preset !== "generative" &&
    (state.preset !== "renderer" || !!state.customRenderer)

  function submit() {
    if (!canDeploy || !factory || !address) return
    const creators = collabCheck.ok ? collabCheck.parsed : []
    const owner = ownerOverride ?? address
    deploy.writeContract({
      address: factory,
      abi: surfaceFactoryAbi,
      functionName: "createSurface",
      args: [state.name.trim(), state.symbol.trim(), owner, buildCfg(), buildSale(), creators],
    })
  }

  if (deployedAddress && coverSettled) {
    return <SuccessScreen collection={deployedAddress} artistAddress={artistAddress} />
  }

  if (deployedAddress) {
    return (
      <div className="space-y-4">
        <p className="text-[11px] font-mono text-gray-500">
          Collection deployed at {deployedAddress}. Finish publishing its
          presentation data (stored in renderer-land, owned by you):
        </p>
        {needsCover && !coverDone && renderAssets && (
          <button
            className={BTN}
            disabled={coverMining}
            onClick={() =>
              coverWrite.writeContract({
                address: renderAssets,
                abi: renderAssetsAbi,
                functionName: "setCover",
                args: [deployedAddress, state.artworkURI.trim()],
              })
            }
          >
            {coverMining ? "Setting cover…" : "Set cover image"}
          </button>
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

  return (
    <div className="space-y-4">
      <header className="space-y-1.5">
        <h3 className="text-sm font-medium">Deploy</h3>
        <p className="text-xs text-gray-500 leading-relaxed">
          One transaction deploys an immutable contract configured with everything
          above: no proxy admin, no upgrade path.
        </p>
      </header>

      {!factory && (
        <p className={ERROR}>No CollectionFactory is configured for this network.</p>
      )}
      {state.preset === "generative" && (
        <p className={ERROR}>
          Generative collections now use a bring-your-own renderer. Deploy from
          the Renderer preset with your renderer contract; the guided generative
          flow is being rebuilt.
        </p>
      )}

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

function useDeployedAddress(receipt: TransactionReceipt | undefined): Address | null {
  if (!receipt) return null
  try {
    const logs = parseEventLogs({
      abi: surfaceFactoryAbi,
      logs: receipt.logs,
      eventName: "SurfaceCreated",
    })
    return (logs[0]?.args as { collection?: Address } | undefined)?.collection ?? null
  } catch {
    return null
  }
}

function SuccessScreen({
  collection,
  artistAddress,
}: {
  collection: Address
  artistAddress: string
}) {
  const router = useRouter()
  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-green-200 bg-green-50 p-5 space-y-2">
        <p className="text-sm font-medium text-green-800">Collection deployed</p>
        <p className="text-xs font-mono text-green-700 break-all">{collection}</p>
      </div>

      <a
        href={`/collections/${collection}`}
        className="block text-center text-[11px] font-mono font-medium uppercase tracking-wider py-3 bg-fg text-bg hover:opacity-80 transition-colors"
      >
        View collection
      </a>

      <div className="rounded-lg border border-gray-200 bg-surface p-4 flex items-center justify-between gap-4">
        <div className="space-y-0.5">
          <p className="text-sm font-medium">Claim it in your Catalog</p>
          <p className="text-xs text-gray-500">
            Add this contract to your onchain record so it shows up as your work.
          </p>
        </div>
        <button
          type="button"
          onClick={() => router.push(studioToolHref(artistAddress, "catalog"))}
          className="shrink-0 text-[11px] font-mono font-medium uppercase tracking-wider px-4 py-2 border border-gray-200 hover:border-gray-400 transition-colors"
        >
          Go to Catalog
        </button>
      </div>
    </div>
  )
}
