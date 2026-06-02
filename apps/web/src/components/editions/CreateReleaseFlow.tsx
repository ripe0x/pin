"use client"

/**
 * The artist flow: deploy a project (one ERC721A contract) then configure a
 * release inside it. Two onchain steps, each fully decoded before signing.
 * Crypto-native: wallet-first, contract addresses shown, honest pricing
 * language throughout ("0 = gas only", the Surface Share explained as coming
 * out of the price).
 */

import { useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import { isAddress, parseEventLogs, type Address } from "viem"
import {
  useAccount,
  useChainId,
  useSwitchChain,
  useWaitForTransactionReceipt,
  useWriteContract,
} from "wagmi"
import { ConnectButton } from "@rainbow-me/rainbowkit"
import { pndEditionsAbi, pndEditionsFactoryAbi } from "@pin/abi"
import { OptimizedImage } from "@/components/OptimizedImage"
import {
  PREFERRED_CHAIN,
  PREFERRED_CHAIN_LABEL,
  formatWriteError,
} from "@/components/tx/tx-ui"
import { useEthAmountInput } from "@/lib/useEthAmountInput"
import {
  ProjectMode,
  RELEASE_KIND_DESCRIPTION,
  RELEASE_KIND_LABEL,
  ReleaseKind,
  ZERO_ADDRESS,
  pndEditionsFactory,
} from "@/lib/pnd-editions"

const LABEL = "block text-[10px] font-mono uppercase tracking-wider text-gray-400 mb-1.5"
const INPUT =
  "w-full px-3 py-2.5 text-sm font-mono bg-surface border border-gray-200 focus:border-gray-400 outline-none transition-colors disabled:opacity-40"
const BTN =
  "block w-full text-center text-[11px] font-mono font-medium uppercase tracking-wider py-3 bg-fg text-bg hover:opacity-80 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
const HELP = "mt-1.5 text-[10px] font-mono text-gray-400 leading-relaxed"

export function CreateReleaseFlow() {
  const { address } = useAccount()
  const chainId = useChainId()
  const { switchChain, isPending: isSwitchPending } = useSwitchChain()
  const wrongNetwork = !!address && chainId !== PREFERRED_CHAIN.id

  const [project, setProject] = useState<Address | null>(null)

  if (!address) {
    return (
      <Shell>
        <ConnectButton.Custom>
          {({ openConnectModal }) => (
            <button onClick={openConnectModal} className={BTN}>
              Connect wallet to start
            </button>
          )}
        </ConnectButton.Custom>
      </Shell>
    )
  }

  if (wrongNetwork) {
    return (
      <Shell>
        <button
          onClick={() => switchChain({ chainId: PREFERRED_CHAIN.id })}
          disabled={isSwitchPending}
          className={BTN}
        >
          {isSwitchPending ? "Switching…" : `Switch to ${PREFERRED_CHAIN_LABEL}`}
        </button>
      </Shell>
    )
  }

  return (
    <div className="space-y-px">
      <StepHeader n={1} title="Project" done={!!project} active={!project} />
      {!project ? (
        <DeployProjectStep onDeployed={setProject} />
      ) : (
        <div className="px-5 py-4 border border-gray-200 bg-surface-muted/30">
          <p className="text-[11px] font-mono text-gray-600">
            Project deployed at{" "}
            <span className="text-fg break-all">{project}</span>
          </p>
        </div>
      )}

      <StepHeader n={2} title="Release" done={false} active={!!project} />
      {project ? (
        <CreateReleaseStep project={project} />
      ) : (
        <div className="px-5 py-4 border border-gray-200 text-[11px] font-mono text-gray-400">
          Deploy or select a project first.
        </div>
      )}
    </div>
  )
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-gray-200 bg-surface p-5 space-y-4">
      <p className="text-[11px] font-mono text-gray-500 leading-relaxed">
        Releasing on PND deploys your own ERC721A contract. You own it. Each
        token a collector mints keeps its own identity and onchain Mint Mark.
      </p>
      {children}
    </div>
  )
}

function StepHeader({
  n,
  title,
  done,
  active,
}: {
  n: number
  title: string
  done: boolean
  active: boolean
}) {
  return (
    <div className="flex items-center gap-2 px-1 py-2">
      <span
        className={`inline-flex h-5 w-5 items-center justify-center rounded-full text-[10px] font-mono ${
          done
            ? "bg-emerald-500 text-white"
            : active
              ? "bg-fg text-bg"
              : "bg-gray-200 text-gray-500"
        }`}
      >
        {done ? "✓" : n}
      </span>
      <span className="text-[11px] font-mono uppercase tracking-wider text-gray-600">{title}</span>
    </div>
  )
}

// ── Step 1: deploy project ──────────────────────────────────────────────────

function DeployProjectStep({ onDeployed }: { onDeployed: (a: Address) => void }) {
  const { address } = useAccount()
  const [name, setName] = useState("")
  const [symbol, setSymbol] = useState("")
  const [mode, setMode] = useState<ProjectMode>(ProjectMode.ImmutableClone)
  const [existing, setExisting] = useState("")

  const factory = pndEditionsFactory()
  const { writeContract, data: txHash, isPending, error, reset } = useWriteContract()
  const { data: receipt, isLoading: mining } = useWaitForTransactionReceipt({ hash: txHash })

  // When the deploy confirms, pull the project address out of ProjectCreated.
  useEffect(() => {
    if (!receipt || !txHash) return
    try {
      const logs = parseEventLogs({
        abi: pndEditionsFactoryAbi,
        logs: receipt.logs,
        eventName: "ProjectCreated",
      })
      const created = logs[0]?.args as { project?: Address } | undefined
      if (created?.project) {
        reset()
        onDeployed(created.project)
      }
    } catch {
      // fall through; user can retry
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [receipt, txHash])

  const canDeploy = name.trim().length > 0 && symbol.trim().length > 0 && !!factory && !!address

  function deploy() {
    if (!factory || !address) return
    writeContract({
      address: factory,
      abi: pndEditionsFactoryAbi,
      functionName: "createProject",
      args: [name.trim(), symbol.trim(), address, mode],
    })
  }

  return (
    <div className="border border-gray-200 bg-surface p-5 space-y-4">
      {!factory && (
        <p className="text-[11px] font-mono text-red-500">
          No PND Editions factory is configured for this network.
        </p>
      )}

      <div>
        <label className={LABEL} htmlFor="proj-name">
          Project name
        </label>
        <input
          id="proj-name"
          className={INPUT}
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Studies in Grey"
          disabled={isPending || mining}
        />
      </div>

      <div>
        <label className={LABEL} htmlFor="proj-symbol">
          Symbol
        </label>
        <input
          id="proj-symbol"
          className={INPUT}
          value={symbol}
          onChange={(e) => setSymbol(e.target.value.toUpperCase())}
          placeholder="GREY"
          disabled={isPending || mining}
        />
      </div>

      <div>
        <span className={LABEL}>Mutability</span>
        <div className="grid grid-cols-2 gap-2">
          <ModeCard
            selected={mode === ProjectMode.ImmutableClone}
            onClick={() => setMode(ProjectMode.ImmutableClone)}
            title="Immutable"
            desc="No upgrade path, ever. Cheapest, maximally credible."
            disabled={isPending || mining}
          />
          <ModeCard
            selected={mode === ProjectMode.Upgradeable}
            onClick={() => setMode(ProjectMode.Upgradeable)}
            title="Upgradeable"
            desc="You can upgrade until you seal it. More flexible."
            disabled={isPending || mining}
          />
        </div>
      </div>

      <button onClick={deploy} disabled={!canDeploy || isPending || mining} className={BTN}>
        {isPending ? "Confirm in wallet…" : mining ? "Deploying…" : "Deploy project"}
      </button>

      {error && (
        <p className="text-[11px] font-mono text-red-500 break-words">
          {formatWriteError(error, "Deploy")}
        </p>
      )}

      <div className="pt-3 border-t border-gray-100">
        <label className={LABEL} htmlFor="proj-existing">
          Or use an existing project you own
        </label>
        <div className="flex gap-2">
          <input
            id="proj-existing"
            className={INPUT}
            value={existing}
            onChange={(e) => setExisting(e.target.value.trim())}
            placeholder="0x…"
          />
          <button
            type="button"
            onClick={() => isAddress(existing) && onDeployed(existing as Address)}
            disabled={!isAddress(existing)}
            className="shrink-0 px-4 text-[11px] font-mono uppercase tracking-wider border border-gray-200 hover:border-gray-400 transition-colors disabled:opacity-40"
          >
            Use
          </button>
        </div>
      </div>
    </div>
  )
}

function ModeCard({
  selected,
  onClick,
  title,
  desc,
  disabled,
}: {
  selected: boolean
  onClick: () => void
  title: string
  desc: string
  disabled?: boolean
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`text-left p-3 border transition-colors ${
        selected ? "border-fg bg-surface-muted/40" : "border-gray-200 hover:border-gray-300"
      } disabled:opacity-40`}
    >
      <p className="text-[11px] font-mono uppercase tracking-wider">{title}</p>
      <p className="mt-1 text-[10px] font-mono text-gray-500 leading-relaxed">{desc}</p>
    </button>
  )
}

// ── Step 2: create release ────────────────────────────────────────────────────

function CreateReleaseStep({ project }: { project: Address }) {
  const router = useRouter()
  const { address } = useAccount()

  const [artworkURI, setArtworkURI] = useState("")
  const price = useEthAmountInput()
  const [surfacePct, setSurfacePct] = useState("0")
  const [openEdition, setOpenEdition] = useState(true)
  const [supplyCap, setSupplyCap] = useState("100")
  const [hasWindow, setHasWindow] = useState(false)
  const [startAt, setStartAt] = useState("")
  const [endAt, setEndAt] = useState("")
  const [royaltyPct, setRoyaltyPct] = useState("10")
  const [kind, setKind] = useState<ReleaseKind>(ReleaseKind.Standalone)
  const [payout, setPayout] = useState("")

  const { writeContract, data: txHash, isPending, error, reset } = useWriteContract()
  const { data: receipt, isLoading: mining } = useWaitForTransactionReceipt({ hash: txHash })

  useEffect(() => {
    if (!receipt || !txHash) return
    try {
      const logs = parseEventLogs({
        abi: pndEditionsAbi,
        logs: receipt.logs,
        eventName: "ReleaseCreated",
      })
      const created = logs[0]?.args as { releaseId?: bigint } | undefined
      if (created?.releaseId !== undefined) {
        const rid = created.releaseId.toString()
        reset()
        router.push(`/editions/${project}/${rid}`)
      }
    } catch {
      // fall through
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [receipt, txHash])

  const surfaceBps = Math.round(Number(surfacePct || "0") * 100)
  const royaltyBps = Math.round(Number(royaltyPct || "0") * 100)
  const priceOk = price.isEmpty || price.isValid // empty => gas only (0)
  const surfaceOk = surfaceBps >= 0 && surfaceBps <= 10_000
  const royaltyOk = royaltyBps >= 0 && royaltyBps <= 10_000
  const capOk = openEdition || (Number(supplyCap) > 0 && Number.isFinite(Number(supplyCap)))
  const payoutOk = payout === "" || isAddress(payout)
  const canSubmit =
    artworkURI.trim().length > 0 && priceOk && surfaceOk && royaltyOk && capOk && payoutOk

  function toUnix(local: string): bigint {
    if (!local) return 0n
    const ms = new Date(local).getTime()
    return Number.isNaN(ms) ? 0n : BigInt(Math.floor(ms / 1000))
  }

  function submit() {
    if (!canSubmit) return
    const cfg = {
      defaultArtworkURI: artworkURI.trim(),
      price: price.wei ?? 0n,
      surfaceShareBps: surfaceBps,
      supplyCap: openEdition ? 0n : BigInt(Math.floor(Number(supplyCap))),
      mintStart: hasWindow ? toUnix(startAt) : 0n,
      mintEnd: hasWindow ? toUnix(endAt) : 0n,
      royaltyBps,
      royaltyReceiver: ZERO_ADDRESS as Address,
      kind,
      payoutAddress: (payout === "" ? ZERO_ADDRESS : payout) as Address,
      renderer: ZERO_ADDRESS as Address,
      mintHook: ZERO_ADDRESS as Address,
    }
    writeContract({
      address: project,
      abi: pndEditionsAbi,
      functionName: "createRelease",
      args: [cfg],
    })
  }

  return (
    <div className="border border-gray-200 bg-surface p-5 space-y-5">
      {/* artwork */}
      <div>
        <label className={LABEL} htmlFor="rel-art">
          Artwork URI
        </label>
        <input
          id="rel-art"
          className={INPUT}
          value={artworkURI}
          onChange={(e) => setArtworkURI(e.target.value.trim())}
          placeholder="ipfs://…"
          disabled={isPending || mining}
        />
        <p className={HELP}>
          The shared art for this release. ipfs:// recommended. Tokens can carry
          unique art later. PND can pin it via Preserve.
        </p>
        {artworkURI.startsWith("ipfs://") || artworkURI.startsWith("https://") ? (
          <div className="mt-3 aspect-square w-32 overflow-hidden rounded border border-gray-200 bg-surface-muted">
            <OptimizedImage
              src={artworkURI}
              alt="Artwork preview"
              width={256}
              className="h-full w-full object-cover"
            />
          </div>
        ) : null}
      </div>

      {/* price + surface */}
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className={LABEL} htmlFor="rel-price">
            Price (ETH)
          </label>
          <input
            id="rel-price"
            {...price.inputProps}
            placeholder="0"
            className={INPUT}
            disabled={isPending || mining}
          />
          <p className={HELP}>0 = gas only. Never called free.</p>
          {price.error && (
            <p className="mt-1 text-[10px] font-mono text-red-500">{price.error}</p>
          )}
        </div>
        <div>
          <label className={LABEL} htmlFor="rel-surface">
            Surface share (%)
          </label>
          <input
            id="rel-surface"
            type="text"
            inputMode="decimal"
            className={INPUT}
            value={surfacePct}
            onChange={(e) => setSurfacePct(e.target.value.replace(/[^0-9.]/g, ""))}
            disabled={isPending || mining || price.isEmpty}
          />
          <p className={HELP}>
            Out of the price, to whatever surface facilitates the mint. 0 = you
            keep 100%.
          </p>
        </div>
      </div>

      {/* supply */}
      <div>
        <label className="flex items-center gap-2 mb-2">
          <input
            type="checkbox"
            checked={openEdition}
            onChange={(e) => setOpenEdition(e.target.checked)}
            disabled={isPending || mining}
          />
          <span className="text-[11px] font-mono text-gray-600">Open edition (no cap)</span>
        </label>
        {!openEdition && (
          <input
            type="number"
            min={1}
            step={1}
            className={INPUT}
            value={supplyCap}
            onChange={(e) => setSupplyCap(e.target.value)}
            disabled={isPending || mining}
            placeholder="Max supply"
          />
        )}
      </div>

      {/* window */}
      <div>
        <label className="flex items-center gap-2 mb-2">
          <input
            type="checkbox"
            checked={hasWindow}
            onChange={(e) => setHasWindow(e.target.checked)}
            disabled={isPending || mining}
          />
          <span className="text-[11px] font-mono text-gray-600">Set a mint window</span>
        </label>
        {hasWindow && (
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={LABEL} htmlFor="rel-start">
                Opens
              </label>
              <input
                id="rel-start"
                type="datetime-local"
                className={INPUT}
                value={startAt}
                onChange={(e) => setStartAt(e.target.value)}
                disabled={isPending || mining}
              />
            </div>
            <div>
              <label className={LABEL} htmlFor="rel-end">
                Closes
              </label>
              <input
                id="rel-end"
                type="datetime-local"
                className={INPUT}
                value={endAt}
                onChange={(e) => setEndAt(e.target.value)}
                disabled={isPending || mining}
              />
            </div>
          </div>
        )}
      </div>

      {/* royalty + kind */}
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className={LABEL} htmlFor="rel-royalty">
            Royalty (%)
          </label>
          <input
            id="rel-royalty"
            type="text"
            inputMode="decimal"
            className={INPUT}
            value={royaltyPct}
            onChange={(e) => setRoyaltyPct(e.target.value.replace(/[^0-9.]/g, ""))}
            disabled={isPending || mining}
          />
          <p className={HELP}>EIP-2981, honored by marketplaces.</p>
        </div>
        <div>
          <label className={LABEL} htmlFor="rel-kind">
            Kind
          </label>
          <select
            id="rel-kind"
            className={INPUT}
            value={kind}
            onChange={(e) => setKind(Number(e.target.value) as ReleaseKind)}
            disabled={isPending || mining}
          >
            {Object.values(ReleaseKind)
              .filter((v) => typeof v === "number")
              .map((v) => (
                <option key={v} value={v as number}>
                  {RELEASE_KIND_LABEL[v as number]}
                </option>
              ))}
          </select>
          <p className={HELP}>{RELEASE_KIND_DESCRIPTION[kind]}</p>
        </div>
      </div>

      {/* payout */}
      <div>
        <label className={LABEL} htmlFor="rel-payout">
          Payout address (optional)
        </label>
        <input
          id="rel-payout"
          className={INPUT}
          value={payout}
          onChange={(e) => setPayout(e.target.value.trim())}
          placeholder={address ?? "defaults to you"}
          disabled={isPending || mining}
        />
        {!payoutOk && <p className="mt-1 text-[10px] font-mono text-red-500">Invalid address</p>}
      </div>

      <button onClick={submit} disabled={!canSubmit || isPending || mining} className={BTN}>
        {isPending ? "Confirm in wallet…" : mining ? "Publishing…" : "Publish release"}
      </button>

      {error && (
        <p className="text-[11px] font-mono text-red-500 break-words">
          {formatWriteError(error, "Create release")}
        </p>
      )}
    </div>
  )
}
