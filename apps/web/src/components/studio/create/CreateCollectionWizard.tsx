"use client"

/**
 * The studio create-collection wizard: an artist who already deployed a
 * renderer contract launches a token contract against it, with no
 * Solidity. Plain client-component state machine, no form library (repo
 * convention). Fixed step graph: renderer -> details -> sale -> deploy.
 * Each chain write (setCover, createSurface) owns its own wagmi
 * useWriteContract + useWaitForTransactionReceipt pair inside its step
 * component.
 */

import { useState } from "react"
import { useAccount, useChainId, useSwitchChain } from "wagmi"
import { ConnectButton } from "@rainbow-me/rainbowkit"
import { PREFERRED_CHAIN, PREFERRED_CHAIN_LABEL } from "@/components/tx/tx-ui"
import { useEthAmountInput } from "@/lib/useEthAmountInput"
import type { FactoryStatus } from "@/lib/collection-onchain"
import { initialWizardState, WIZARD_STEPS, type StepId, type WizardState } from "./types"
import { Stepper } from "./Stepper"
import { RendererStep } from "./RendererStep"
import { DetailsStep } from "./DetailsStep"
import { SaleStep } from "./SaleStep"
import { DeployStep } from "./DeployStep"
import { BTN } from "./wizard-ui"

/** Why the wizard can't offer a deploy right now, or null when it can. */
function blockedReason(status: FactoryStatus): { headline: string; lead: string } | null {
  if (!status.configured) {
    return { headline: "Not available", lead: "Deploys aren't live on this network." }
  }
  if (status.deprecated) {
    return { headline: "Retired", lead: "A new factory is coming." }
  }
  if (status.paused) {
    return { headline: "Not open yet", lead: "Interested in deploying a collection?" }
  }
  return null
}

export function CreateCollectionWizard({
  artistAddress,
  factoryStatus,
}: {
  artistAddress: string
  factoryStatus: FactoryStatus
}) {
  const { address } = useAccount()
  const chainId = useChainId()
  const { switchChain, isPending: isSwitchPending } = useSwitchChain()
  const wrongNetwork = !!address && chainId !== PREFERRED_CHAIN.id

  const [state, setState] = useState<WizardState>(initialWizardState)
  const [step, setStep] = useState<StepId>("renderer")

  const price = useEthAmountInput()

  function set<K extends keyof WizardState>(key: K, value: WizardState[K]) {
    setState((s) => ({ ...s, [key]: value }))
  }

  function stepAfter(current: StepId): StepId {
    const idx = WIZARD_STEPS.indexOf(current)
    return WIZARD_STEPS[Math.min(idx + 1, WIZARD_STEPS.length - 1)]
  }

  function stepBefore(current: StepId): StepId {
    const idx = WIZARD_STEPS.indexOf(current)
    return WIZARD_STEPS[Math.max(idx - 1, 0)]
  }

  const blocked = blockedReason(factoryStatus)
  if (blocked) {
    return (
      <div className="rounded-lg border border-amber-200 bg-amber-50 p-5 space-y-1">
        <p className="text-sm font-medium text-amber-900">{blocked.headline}</p>
        <p className="text-xs text-amber-800 leading-relaxed">
          {blocked.lead} Send{" "}
          <a
            href="https://x.com/ripe0x"
            target="_blank"
            rel="noopener noreferrer"
            className="underline hover:no-underline"
          >
            ripe
          </a>{" "}
          a DM for more info.
        </p>
      </div>
    )
  }

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
    <div className="space-y-6">
      <header className="space-y-1.5">
        <h1 className="text-xl font-semibold tracking-tight">Launch a collection</h1>
        <p className="text-sm text-gray-500 leading-relaxed">
          Deploys your own immutable contract that renders through the renderer
          you already deployed. No protocol fee. Only your wallet has admin
          access.
        </p>
      </header>

      <Stepper steps={WIZARD_STEPS} current={step} />

      <div className="rounded-lg border border-gray-200 bg-surface p-5">
        {step === "renderer" && (
          <RendererStep state={state} set={set} onNext={() => setStep(stepAfter("renderer"))} />
        )}

        {step === "details" && (
          <DetailsStep
            state={state}
            set={set}
            onBack={() => setStep(stepBefore("details"))}
            onNext={() => setStep(stepAfter("details"))}
          />
        )}

        {step === "sale" && (
          <SaleStep
            state={state}
            set={set}
            price={price}
            onBack={() => setStep(stepBefore("sale"))}
            onNext={() => setStep(stepAfter("sale"))}
          />
        )}

        {step === "deploy" && (
          <DeployStep
            state={state}
            artistAddress={artistAddress}
            price={price}
            onBack={() => setStep(stepBefore("deploy"))}
          />
        )}
      </div>
    </div>
  )
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-gray-200 bg-surface p-5 space-y-4">
      <p className="text-[11px] font-mono text-gray-500 leading-relaxed">
        Deploy an onchain contract configured with your artwork and mint conditions.
      </p>
      {children}
    </div>
  )
}
