"use client"

/**
 * Step 4: review every value, then one deploy transaction.
 *
 * Surface v2 (the default wherever a Launcher is configured): one
 * Launcher.launch call deploys the collection and its FixedPriceSale,
 * already wired to each other (contracts/src/surface/v2/Launcher.sol). The
 * royalty receiver and payout recipient go in as zero when left empty: the
 * Launcher resolves both to the owner. v2 has no cover registry and no
 * onchain creator roster (the renderer's contractURI is the cover; the
 * Catalog carries credit), so neither is written.
 *
 * Otherwise (v1 / the superseded Sepolia v2): a single createSurface write on
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
 * SuccessScreen shows the deployed address and links to the collection page
 * and its studio settings; it does not render a preview. The collection
 * page itself shows a sample render for an unminted collection (see the
 * pre-mint hero in app/collections/[address]/page.tsx).
 */

import { useEffect, useRef } from "react"
import { type Abi, type Address } from "viem"
import {
  useAccount,
  useChainId,
  useConfig,
  useWriteContract,
  useWaitForTransactionReceipt,
} from "wagmi"
import { simulateContract } from "wagmi/actions"
import { launcherAbi, surfaceFactoryAbi, surfaceFactoryV2Abi, renderAssetsAbi } from "@pin/abi"
import { PREFERRED_CHAIN, formatWriteError } from "@/components/tx/tx-ui"
import {
  ZERO_ADDRESS,
  launcherV2,
  surfaceFactory,
  surfaceFactoryV2,
  renderAssetsAddress,
} from "@/lib/collection"
import { buildReviewSummary, isValidArtworkURI } from "@/lib/create-collection"
import { buildLaunchArgs } from "@/lib/surface-v2-studio"
import { studioToolHref } from "@/lib/studio-tools"
import { usePreflight } from "@/lib/use-preflight"
import { parseDeployedCollectionAddress, parseLaunchedAddresses } from "./parse-deployed-address"
import { validateCollaborators } from "./SharedFields"
import type { UseEthAmountInputResult } from "@/lib/useEthAmountInput"
import type { WizardState } from "./types"
import { BTN, BTN_SECONDARY, ERROR } from "./wizard-ui"

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
  const config = useConfig()
  // The primitive v2 Launcher wins when it resolves for this chain; then
  // the superseded SurfaceFactoryV2 (Sepolia only); v1 is the fallback.
  // getFactoryStatus (the wizard's block screen) picks in the same order.
  const launcher = launcherV2(chainId)
  const factoryV2 = launcher ? null : surfaceFactoryV2(chainId)
  const factoryV1 = surfaceFactory(chainId)
  const factory = launcher ?? factoryV2 ?? factoryV1
  const renderAssets = launcher ? null : renderAssetsAddress(chainId)
  const priceWei = price.wei ?? 0n

  const deploy = useWriteContract()
  const preflight = usePreflight()
  const { data: receipt, isLoading: mining } = useWaitForTransactionReceipt({
    hash: deploy.data,
    chainId: PREFERRED_CHAIN.id,
  })

  const launched = launcher ? parseLaunchedAddresses(receipt, launcher) : null
  const deployedAddress = launcher
    ? (launched?.collection ?? null)
    : parseDeployedCollectionAddress(receipt, !!factoryV2)

  // Post-deploy configuration: presentation data lives in renderer-land. A
  // cover image goes to RenderAssets, its own tx, authorized by the
  // collection owner (the connected artist).
  const coverWrite = useWriteContract()
  const { isLoading: coverMining, isSuccess: coverDone } = useWaitForTransactionReceipt({
    hash: coverWrite.data,
  })

  // v2 has no cover registry: the renderer's contractURI is the cover.
  const needsCover = !launcher && state.artworkURI.trim().length > 0
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
      chainId: PREFERRED_CHAIN.id,
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

  const artworkOk = !!launcher || state.artworkURI.trim() === "" || isValidArtworkURI(state.artworkURI)

  const canDeploy = !!factory && !!address && !!state.rendererAddress && artworkOk

  /** The deploy call for whichever path this chain resolves to. */
  function deployCall(): { address: Address; abi: Abi; functionName: string; args: readonly unknown[] } | null {
    if (!factory || !address) return null
    const creators = collabCheck.ok ? collabCheck.parsed : []
    const owner = ownerOverride ?? address
    const name = state.name.trim()
    const symbol = state.symbol.trim()
    if (launcher) {
      const sale = buildSaleBase()
      return {
        address: launcher,
        abi: launcherAbi as Abi,
        functionName: "launch",
        args: buildLaunchArgs({
          name,
          symbol,
          owner,
          renderer: state.rendererAddress as Address,
          supplyCap: state.openSupply ? null : BigInt(Math.floor(Number(state.supplyCap))),
          royaltyBps,
          // Empty = zero = the owner, resolved by the Launcher.
          royaltyReceiver: "",
          priceWei,
          mintStart: sale.mintStart,
          mintEnd: sale.mintEnd,
          maxMints: sale.maxMints,
          payoutRecipient: state.payout,
        }),
      }
    }
    const cfg = buildCfg()
    if (factoryV2) {
      // v2's SaleConfig drops priceStrategy (FixedPriceMinterV2 is
      // exact-payment only). seedSource is init-only with no wizard UI (see
      // docs/pnd-surface-v2-plan.md): every wizard-deployed v2 collection
      // derives its own seeds.
      return {
        address: factoryV2,
        abi: surfaceFactoryV2Abi as Abi,
        functionName: "createSurface",
        args: [name, symbol, owner, cfg, buildSaleBase(), creators, ZERO_ADDRESS as Address],
      }
    }
    return {
      address: factory,
      abi: surfaceFactoryAbi as Abi,
      functionName: "createSurface",
      args: [
        name,
        symbol,
        owner,
        cfg,
        { ...buildSaleBase(), priceStrategy: ZERO_ADDRESS as Address },
        creators,
      ],
    }
  }

  function submit() {
    if (!canDeploy || !address) return
    const call = deployCall()
    if (!call) return
    deploy.reset()
    // Simulate from the connected account on PREFERRED_CHAIN first, so a
    // paused factory or a bad renderer shows its decoded reason here
    // instead of in a failed transaction; then sign that request.
    void preflight.run(async () => {
      const { request } = await simulateContract(config, {
        account: address,
        chainId: PREFERRED_CHAIN.id,
        ...call,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      deploy.writeContract({ ...(request as any), chainId: PREFERRED_CHAIN.id })
    })
  }

  if (deployedAddress && coverSettled) {
    return (
      <SuccessScreen collection={deployedAddress} sale={launched?.sale ?? null} artistAddress={artistAddress} />
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
                chainId: PREFERRED_CHAIN.id,
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

  const busy = preflight.checking || deploy.isPending || mining
  const summary = buildReviewSummary(state, price.rawValue, { v2: !!launcher })
  const droppedForV2 =
    !!launcher &&
    (state.artworkURI.trim() !== "" || state.collaborators.some((c) => c.address.trim() !== ""))

  return (
    <div className="space-y-4">
      <header className="space-y-1.5">
        <h3 className="text-sm font-medium">Review and deploy</h3>
        <p className="text-xs text-gray-500 leading-relaxed">
          {launcher
            ? "One transaction deploys your collection and its sale, wired to each other: no proxy admin, no upgrade path. You keep every setting until you renounce ownership."
            : "One transaction deploys an immutable contract configured with everything below: no proxy admin, no upgrade path."}
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
      {!artworkOk && !launcher && <p className={ERROR}>Cover image URI must start with ipfs://, ar://, or https://</p>}
      {droppedForV2 && (
        <p className="text-[11px] font-mono text-gray-500 leading-relaxed">
          A v2 collection has no onchain cover or creator roster: its cover comes from your renderer&apos;s
          contractURI, and co-creators are credited in the Catalog. The cover and collaborators above are not
          written.
        </p>
      )}

      <button onClick={submit} disabled={!canDeploy || busy} className={BTN}>
        {preflight.checking
          ? "Checking…"
          : deploy.isPending
            ? "Confirm in wallet…"
            : mining
              ? "Deploying…"
              : "Deploy collection"}
      </button>

      {preflight.error !== null && <p className={ERROR}>{formatWriteError(preflight.error, "Deploy")}</p>}
      {deploy.error && <p className={ERROR}>{formatWriteError(deploy.error, "Deploy")}</p>}

      <button onClick={onBack} disabled={busy} className={BTN_SECONDARY}>
        Back
      </button>
    </div>
  )
}

function SuccessScreen({
  collection,
  sale,
  artistAddress,
}: {
  collection: Address
  /** The v2 sale the Launcher wired in; null on the factory paths. */
  sale: Address | null
  artistAddress: string
}) {
  const toolHref = (tool: string) => `${studioToolHref(artistAddress, tool)}?collection=${collection}`
  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-green-200 bg-green-50 p-5 space-y-2">
        <p className="text-sm font-medium text-green-800">Collection deployed</p>
        <p className="text-xs font-mono text-green-700 break-all">{collection}</p>
        {sale && <p className="text-[11px] font-mono text-green-700 break-all">Sale: {sale}</p>}
      </div>

      <a
        href={`/collections/${collection}`}
        className="block text-center text-[11px] font-mono font-medium uppercase tracking-wider py-3 bg-fg text-bg hover:opacity-80 transition-colors"
      >
        View collection
      </a>
      <a
        href={toolHref("collections")}
        className="block text-center text-[11px] font-mono font-medium uppercase tracking-wider px-4 py-2 border border-gray-200 hover:border-gray-400 transition-colors"
      >
        Collection settings
      </a>
      {sale && (
        <div className="grid grid-cols-2 gap-2">
          <a
            href={toolHref("sale")}
            className="block text-center text-[11px] font-mono font-medium uppercase tracking-wider px-4 py-2 border border-gray-200 hover:border-gray-400 transition-colors"
          >
            Sale settings
          </a>
          <a
            href={toolHref("mint-gate")}
            className="block text-center text-[11px] font-mono font-medium uppercase tracking-wider px-4 py-2 border border-gray-200 hover:border-gray-400 transition-colors"
          >
            Mint gate
          </a>
        </div>
      )}
    </div>
  )
}
