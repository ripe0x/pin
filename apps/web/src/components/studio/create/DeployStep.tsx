"use client"

/**
 * Final step for all three presets: a single createCollection write on
 * SovereignCollectionFactory, ported from CreateEditionForm's
 * useWriteContract + useWaitForTransactionReceipt + parseEventLogs pattern.
 * Builds CollectionConfig + WorkConfig from wizard state per preset:
 *
 *   EDITION:   empty WorkConfig, Sequential id mode, renderer = zero
 *              (DefaultRenderer, the factory's baked-in default).
 *   GENERATIVE: WorkConfig.code = [{store: SCRIPTY_STORAGE_V2, name, kind:
 *              Script}], deps = chosen ScriptGzip refs, renderer =
 *              GENERATIVE_RENDERER (must be explicit — the factory default
 *              is DefaultRenderer, not GenerativeRenderer).
 *   RENDERER:  empty WorkConfig, renderer = the artist-supplied address.
 */

import { useRouter } from "next/navigation"
import { parseEventLogs, type Address, type TransactionReceipt } from "viem"
import { useAccount, useChainId, useWriteContract, useWaitForTransactionReceipt } from "wagmi"
import { sovereignCollectionFactoryAbi } from "@pin/abi"
import { formatWriteError } from "@/components/tx/tx-ui"
import {
  ZERO_ADDRESS,
  IdMode,
  Liveness,
  sovereignCollectionFactory,
  generativeRenderer,
} from "@/lib/sovereign-collection"
import { KNOWN_DEPENDENCIES, dependencyCodeRef, CodeKind } from "@/lib/create-collection"
import { studioToolHref } from "@/lib/studio-tools"
import { SCRIPTY_STORAGE_V2, getAddressOrNull } from "@pin/addresses"
import { validateCollaborators } from "./SharedFields"
import type { WizardState } from "./types"
import { BTN, BTN_SECONDARY, ERROR } from "./wizard-ui"

type UploadResult = { name: string; codeHash: `0x${string}` } | null

export function DeployStep({
  state,
  artistAddress,
  priceWei,
  uploadResult,
  onBack,
}: {
  state: WizardState
  artistAddress: string
  priceWei: bigint
  uploadResult: UploadResult
  onBack: () => void
}) {
  const { address } = useAccount()
  const chainId = useChainId()
  const factory = sovereignCollectionFactory(chainId)
  const renderer = generativeRenderer(chainId)
  const scriptyStorage = getAddressOrNull(SCRIPTY_STORAGE_V2, chainId)

  const deploy = useWriteContract()
  const { data: receipt, isLoading: mining } = useWaitForTransactionReceipt({
    hash: deploy.data,
  })

  const deployedAddress = useDeployedAddress(receipt)

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
        : state.preset === "generative"
          ? ((renderer ?? ZERO_ADDRESS) as Address)
          : (ZERO_ADDRESS as Address)

    // Economics are preset-independent: renderer-native works sell through
    // the same built-in paid path; only the artwork source differs.
    return {
      artworkURI: state.artworkURI.trim(),
      price: priceWei,
      supplyCap: state.openSupply ? 0n : BigInt(Math.floor(Number(state.supplyCap))),
      mintStart: state.hasWindow ? toUnix(state.startAt) : 0n,
      mintEnd: state.hasWindow ? toUnix(state.endAt) : 0n,
      royaltyBps,
      royaltyReceiver: ZERO_ADDRESS as Address,
      kind: 0, // CollectionKind.Standalone
      payoutAddress: (state.payout !== "" ? state.payout : ZERO_ADDRESS) as Address,
      renderer: rendererAddr,
      mintHook: ZERO_ADDRESS as Address,
      priceStrategy: ZERO_ADDRESS as Address,
      idMode: IdMode.Sequential,
    }
  }

  function buildWorkCfg() {
    if (state.preset !== "generative" || !uploadResult || !scriptyStorage) {
      return {
        code: [],
        deps: [],
        codeURI: "",
        codeHash: ("0x" + "0".repeat(64)) as `0x${string}`,
        liveness: Liveness.Pure,
        injectionVersion: 1,
        renderParams: "",
      }
    }
    const deps = state.selectedDeps
      .map((id) => KNOWN_DEPENDENCIES.find((d) => d.id === id))
      .filter((d): d is (typeof KNOWN_DEPENDENCIES)[number] => !!d)
      .map((d) => dependencyCodeRef(d.file, chainId))
      .filter((ref): ref is NonNullable<typeof ref> => ref !== null)

    return {
      code: [{ store: scriptyStorage, name: uploadResult.name, kind: CodeKind.Script as number }],
      deps,
      codeURI: "",
      codeHash: uploadResult.codeHash,
      liveness: state.liveness,
      injectionVersion: 1,
      renderParams: state.renderParams,
    }
  }

  const canDeploy =
    !!factory &&
    !!address &&
    (state.preset !== "generative" || (!!uploadResult && !!renderer)) &&
    (state.preset !== "renderer" || !!state.customRenderer)

  function submit() {
    if (!canDeploy || !factory || !address) return
    const artists = collabCheck.ok ? collabCheck.parsed : []
    deploy.writeContract({
      address: factory,
      abi: sovereignCollectionFactoryAbi,
      functionName: "createCollection",
      args: [state.name.trim(), state.symbol.trim(), address, buildCfg(), buildWorkCfg(), [], artists],
    })
  }

  if (deployedAddress) {
    return <SuccessScreen collection={deployedAddress} artistAddress={artistAddress} />
  }

  const busy = deploy.isPending || mining

  return (
    <div className="space-y-4">
      <header className="space-y-1.5">
        <h3 className="text-sm font-medium">Deploy</h3>
        <p className="text-xs text-gray-500 leading-relaxed">
          One transaction deploys your own immutable contract, configured with
          everything above. You own it: no proxy admin, no upgrade path.
        </p>
      </header>

      {!factory && (
        <p className={ERROR}>No SovereignCollectionFactory is configured for this network.</p>
      )}
      {state.preset === "generative" && !renderer && (
        <p className={ERROR}>No GenerativeRenderer is configured for this network.</p>
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
      abi: sovereignCollectionFactoryAbi,
      logs: receipt.logs,
      eventName: "CollectionCreated",
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
