"use client"

/**
 * The studio create-collection wizard: an artist ships a generative
 * collection (or an edition, or a renderer-native work) with no Solidity.
 * Plain client-component state machine, no form library (repo convention).
 *
 * Step graph:
 *   EDITION / RENDERER-NATIVE: preset -> config -> deploy
 *   GENERATIVE:                preset -> config -> preview -> upload -> deploy
 *
 * Each chain write (script chunk uploads, the final createCollection) owns
 * its own wagmi useWriteContract + useWaitForTransactionReceipt pair inside
 * its step component, mirroring CreateEditionForm's per-step write pattern.
 */

import { useState } from "react"
import { useAccount, useChainId, useSwitchChain } from "wagmi"
import { ConnectButton } from "@rainbow-me/rainbowkit"
import { PREFERRED_CHAIN, PREFERRED_CHAIN_LABEL } from "@/components/tx/tx-ui"
import { useEthAmountInput } from "@/lib/useEthAmountInput"
import { initialWizardState, stepsForPreset, type StepId, type WizardState } from "./types"
import { Stepper } from "./Stepper"
import { PresetStep } from "./PresetStep"
import { ConfigStep } from "./ConfigStep"
import { PreviewStep } from "./PreviewStep"
import { UploadStep } from "./UploadStep"
import { DeployStep } from "./DeployStep"
import { BTN } from "./wizard-ui"

export function CreateCollectionWizard({ artistAddress }: { artistAddress: string }) {
  const { address } = useAccount()
  const chainId = useChainId()
  const { switchChain, isPending: isSwitchPending } = useSwitchChain()
  const wrongNetwork = !!address && chainId !== PREFERRED_CHAIN.id

  const [state, setState] = useState<WizardState>(initialWizardState)
  const [step, setStep] = useState<StepId>("preset")
  const [uploadResult, setUploadResult] = useState<{
    name: string
    codeHash: `0x${string}`
  } | null>(null)

  const price = useEthAmountInput()

  function set<K extends keyof WizardState>(key: K, value: WizardState[K]) {
    setState((s) => ({ ...s, [key]: value }))
  }

  const steps = stepsForPreset(state.preset)

  function goTo(next: StepId) {
    setStep(next)
  }

  function stepAfter(current: StepId): StepId {
    const idx = steps.indexOf(current)
    return steps[Math.min(idx + 1, steps.length - 1)]
  }

  function stepBefore(current: StepId): StepId {
    const idx = steps.indexOf(current)
    return steps[Math.max(idx - 1, 0)]
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
      {step !== "preset" && <Stepper steps={steps} current={step} />}

      <div className="rounded-lg border border-gray-200 bg-surface p-5">
        {step === "preset" && (
          <PresetStep
            onSelect={(preset) => {
              set("preset", preset)
              goTo("config")
            }}
          />
        )}

        {step === "config" && (
          <ConfigStep
            state={state}
            set={set}
            price={price}
            disabled={false}
            onNext={() => goTo(stepAfter("config"))}
          />
        )}

        {step === "preview" && (
          <PreviewStep
            state={state}
            set={set}
            onBack={() => goTo(stepBefore("preview"))}
            onNext={() => goTo(stepAfter("preview"))}
          />
        )}

        {step === "upload" && (
          <UploadStep
            state={state}
            set={set}
            onBack={() => goTo(stepBefore("upload"))}
            onNext={(result) => {
              setUploadResult(result)
              goTo(stepAfter("upload"))
            }}
          />
        )}

        {step === "deploy" && (
          <DeployStep
            state={state}
            artistAddress={artistAddress}
            priceWei={price.wei ?? 0n}
            onBack={() => goTo(stepBefore("deploy"))}
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
        Deploy your own onchain contract, configured with your artwork or generative
        script and mint conditions in one guided flow. You own it outright.
      </p>
      {children}
    </div>
  )
}
