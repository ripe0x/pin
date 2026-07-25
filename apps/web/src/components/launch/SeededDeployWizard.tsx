"use client"

/**
 * Seeded deploy page for a launch descriptor (docs/pnd-surface-second-launch.md
 * "Deploy page"): the RENDERER preset only, pre-filled from
 * lib/launch-descriptors.ts and fully editable before signing. Reuses the
 * studio wizard's own ConfigStep + DeployStep — buildCfg/buildSale and the
 * createSurface write live there, not duplicated here (see
 * components/studio/create/DeployStep.tsx). This component owns seeding,
 * the owner-is-the-connected-wallet guarantee, the extra validation the
 * launch doc calls for (renderer code check, mint-window ordering), and
 * the plain-language review card.
 */

import { useMemo, useState } from "react"
import { isAddress, parseEther, type Address } from "viem"
import { useAccount, useChainId, usePublicClient, useSwitchChain } from "wagmi"
import { PREFERRED_CHAIN, PREFERRED_CHAIN_LABEL } from "@/components/tx/tx-ui"
import { useEthAmountInput } from "@/lib/useEthAmountInput"
import { formatBps } from "@/lib/collection"
import type { LaunchDescriptor } from "@/lib/launch-descriptors"
import { ConfigStep } from "@/components/studio/create/ConfigStep"
import { DeployStep } from "@/components/studio/create/DeployStep"
import { validateCollaborators } from "@/components/studio/create/SharedFields"
import type { WizardState } from "@/components/studio/create/types"
import { BTN, BTN_SECONDARY, ERROR, HELP, INPUT, LABEL } from "@/components/studio/create/wizard-ui"

function descriptorToState(d: LaunchDescriptor): WizardState {
  return {
    preset: "renderer",
    name: d.name,
    symbol: d.symbol,
    artworkURI: "",
    priceRaw: "",
    openSupply: d.supplyCap.trim() === "",
    supplyCap: d.supplyCap.trim() === "" ? "100" : d.supplyCap,
    hasWindow: d.mintStart.trim() !== "" || d.mintEnd.trim() !== "",
    startAt: d.mintStart,
    endAt: d.mintEnd,
    royaltyPct: (d.royaltyBps / 100).toString(),
    payout: d.payoutRecipient,
    collaborators: d.creators.map((address) => ({ address })),
    script: "",
    scriptFileName: null,
    selectedDeps: [],
    renderParams: "",
    customRenderer: d.renderer,
    contentNameChosen: null,
    chunksUploaded: 0,
    totalChunks: 0,
    deployedAddress: null,
  }
}

type Step = "config" | "review"

export function SeededDeployWizard({ descriptor }: { descriptor: LaunchDescriptor }) {
  const { address } = useAccount()
  const chainId = useChainId()
  const { switchChain, isPending: isSwitchPending } = useSwitchChain()
  const publicClient = usePublicClient()
  const wrongNetwork = !!address && chainId !== PREFERRED_CHAIN.id

  const [state, setState] = useState<WizardState>(() => descriptorToState(descriptor))
  const [step, setStep] = useState<Step>("config")
  const [ownerOverrideInput, setOwnerOverrideInput] = useState("")
  const [showAdvancedOwner, setShowAdvancedOwner] = useState(false)
  const [showAdvancedRenderer, setShowAdvancedRenderer] = useState(false)
  const [codeCheck, setCodeCheck] = useState<"idle" | "checking" | "has-code" | "no-code" | "error">(
    "idle",
  )

  const price = useEthAmountInput({
    initialWei: descriptor.price.trim() !== "" ? parseEther(descriptor.price.trim()) : null,
  })

  function set<K extends keyof WizardState>(key: K, value: WizardState[K]) {
    setState((s) => ({ ...s, [key]: value }))
  }

  async function checkRendererCode() {
    if (!publicClient || !isAddress(state.customRenderer)) return
    setCodeCheck("checking")
    try {
      const code = await publicClient.getBytecode({ address: state.customRenderer as Address })
      setCodeCheck(code && code !== "0x" ? "has-code" : "no-code")
    } catch {
      setCodeCheck("error")
    }
  }

  // Extra validation beyond ConfigStep's own gate (which already enforces
  // royaltyBps <= 5000 and a valid renderer address): mint-window ordering,
  // since the deploy tx will happily accept start >= end and produce a
  // window that never opens.
  const windowOk = useMemo(() => {
    if (!state.hasWindow || !state.startAt || !state.endAt) return true
    return new Date(state.startAt).getTime() < new Date(state.endAt).getTime()
  }, [state.hasWindow, state.startAt, state.endAt])

  const ownerOverride =
    showAdvancedOwner && isAddress(ownerOverrideInput) ? (ownerOverrideInput as Address) : undefined

  if (!address) {
    return (
      <Shell>
        <p className="text-[11px] font-mono text-gray-500">Connect your wallet to deploy.</p>
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

  if (step === "config") {
    return (
      <Shell>
        <ConfigStep
          state={state}
          set={set}
          price={price}
          disabled={false}
          onNext={() => setStep("review")}
        />
      </Shell>
    )
  }

  // step === "review"
  const collabCheck = validateCollaborators(state.collaborators)
  const rendererOk = isAddress(state.customRenderer)
  const canDeploy = windowOk && rendererOk && collabCheck.ok

  return (
    <Shell>
      <div className="space-y-5">
        <header className="space-y-1.5">
          <h3 className="text-sm font-medium">Review</h3>
          <p className="text-xs text-gray-500 leading-relaxed">
            Confirm everything below before signing. One transaction deploys an
            immutable contract configured exactly as shown.
          </p>
        </header>

        <div className="rounded-lg border border-gray-200 p-4 space-y-2 text-[11px] font-mono">
          <ReviewRow label="Name" value={`${state.name} (${state.symbol})`} />
          <ReviewRow
            label="Price"
            value={price.isEmpty || price.wei === 0n || price.wei === null ? "Gas only" : `${price.rawValue} ETH`}
          />
          <ReviewRow
            label="Quantity"
            value={state.openSupply ? "Open supply" : `${state.supplyCap} max`}
          />
          <ReviewRow
            label="Window"
            value={state.hasWindow ? `${state.startAt || "now"} → ${state.endAt || "open"}` : "Open now, no end"}
          />
          <ReviewRow
            label="Royalty"
            value={`${state.royaltyPct}% (${formatBps(Math.round(Number(state.royaltyPct || "0") * 100))})`}
          />
          <ReviewRow
            label="Owner"
            value={ownerOverride ? `${ownerOverride} (advanced override)` : `${address} (you)`}
          />
          <ReviewRow label="Renderer" value={state.customRenderer} />
        </div>

        {!windowOk && (
          <p className={ERROR}>Mint window closes before it opens — fix the start/end times.</p>
        )}

        <div className="rounded-lg border border-gray-200 p-4 space-y-2">
          <p className="text-[10px] font-mono uppercase tracking-wider text-gray-400">
            You will own this collection
          </p>
          <p className="text-xs font-mono break-all">{address}</p>
          <button
            type="button"
            className="text-[10px] font-mono uppercase tracking-wider text-gray-500 underline hover:text-fg"
            onClick={() => setShowAdvancedOwner((v) => !v)}
          >
            {showAdvancedOwner ? "Hide advanced" : "Advanced: use a different owner (e.g. a Safe)"}
          </button>
          {showAdvancedOwner && (
            <div>
              <input
                className={INPUT}
                value={ownerOverrideInput}
                onChange={(e) => setOwnerOverrideInput(e.target.value.trim())}
                placeholder="0x… owner override"
              />
              {ownerOverrideInput !== "" && !isAddress(ownerOverrideInput) && (
                <p className={ERROR}>Invalid address</p>
              )}
              <p className={HELP}>
                You still sign the deploy transaction with your connected wallet; this
                only changes the owner recorded on the collection.
              </p>
            </div>
          )}
        </div>

        <div className="rounded-lg border border-gray-200 p-4 space-y-2">
          <label className={LABEL}>Renderer address (advanced)</label>
          <button
            type="button"
            className="text-[10px] font-mono uppercase tracking-wider text-gray-500 underline hover:text-fg"
            onClick={() => setShowAdvancedRenderer((v) => !v)}
          >
            {showAdvancedRenderer ? "Hide" : "Show / edit renderer address"}
          </button>
          {showAdvancedRenderer && (
            <input
              className={INPUT}
              value={state.customRenderer}
              onChange={(e) => set("customRenderer", e.target.value.trim())}
              placeholder="0x…"
            />
          )}
          <div className="flex items-center gap-3">
            <button type="button" className={BTN_SECONDARY} onClick={checkRendererCode}>
              {codeCheck === "checking" ? "Checking…" : "Verify renderer has code"}
            </button>
            {codeCheck === "has-code" && (
              <p className="text-[10px] font-mono text-green-600">Contract code found.</p>
            )}
            {codeCheck === "no-code" && (
              <p className={ERROR}>
                No code at this address — the collection would render nothing.
              </p>
            )}
            {codeCheck === "error" && <p className={ERROR}>Could not check (RPC error).</p>}
          </div>
          <p className={HELP}>
            Soft check, not a hard gate: confirms the address has deployed bytecode
            before you sign. It cannot confirm the code implements IRenderer.
          </p>
        </div>

        {collabCheck.error && <p className={ERROR}>{collabCheck.error}</p>}

        {canDeploy ? (
          <DeployStep
            state={state}
            artistAddress={address}
            priceWei={price.wei ?? 0n}
            onBack={() => setStep("config")}
            ownerOverride={ownerOverride}
          />
        ) : (
          <div className="space-y-3">
            <p className={ERROR}>Fix the issues above before deploying.</p>
            <button onClick={() => setStep("config")} className={BTN_SECONDARY}>
              Back to edit
            </button>
          </div>
        )}
      </div>
    </Shell>
  )
}

function ReviewRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <span className="text-[10px] uppercase tracking-wider text-gray-400">{label}</span>
      <span className="truncate text-right">{value}</span>
    </div>
  )
}

function Shell({ children }: { children: React.ReactNode }) {
  return <div className="rounded-lg border border-gray-200 bg-surface p-5 space-y-4">{children}</div>
}
