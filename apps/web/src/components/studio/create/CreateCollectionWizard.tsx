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
import { useSearchParams } from "next/navigation"
import { useAccount, useChainId, useSwitchChain } from "wagmi"
import { ConnectButton } from "@rainbow-me/rainbowkit"
import { PREFERRED_CHAIN, PREFERRED_CHAIN_LABEL } from "@/components/tx/tx-ui"
import { useEthAmountInput } from "@/lib/useEthAmountInput"
import { parseLaunchLink } from "@/lib/create-collection-launch-link"
import { parseEthAmount } from "@/lib/parseEthAmount"
import type { FactoryStatus } from "@/lib/collection-onchain"
import { initialWizardState, stepsForPreset, type StepId, type WizardState } from "./types"
import { Stepper } from "./Stepper"
import { PresetStep } from "./PresetStep"
import { ConfigStep } from "./ConfigStep"
import { PreviewStep } from "./PreviewStep"
import { UploadStep } from "./UploadStep"
import { DeployStep } from "./DeployStep"
import { BTN } from "./wizard-ui"

/** Wei parsed from a launch link's `price` param, if any: feeds the price
 *  input's one-time initialWei seed (see useEthAmountInput). */
function launchLinkPriceWei(priceRaw: string | undefined): bigint | null {
  if (!priceRaw) return null
  const parsed = parseEthAmount(priceRaw)
  return parsed.ok ? parsed.wei : null
}

/** Dismissible notice shown when the wizard was seeded from a launch link.
 *  Lists any param the link carried that failed validation and was dropped,
 *  so the artist knows to fill that field in by hand. */
function LaunchLinkBanner({
  ignored,
  dismissed,
  onDismiss,
}: {
  ignored: string[]
  dismissed: boolean
  onDismiss: () => void
}) {
  if (dismissed) return null
  return (
    <div className="rounded-lg border border-blue-200 bg-blue-50 px-4 py-3 space-y-1.5">
      <div className="flex items-start justify-between gap-3">
        <p className="text-xs text-blue-900 leading-relaxed">
          Prefilled from a launch link. Check every value before you deploy.
        </p>
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Dismiss"
          className="shrink-0 text-blue-700 hover:text-blue-900 leading-none"
        >
          ✕
        </button>
      </div>
      {ignored.length > 0 && (
        <ul className="text-[11px] font-mono text-blue-800 space-y-0.5">
          {ignored.map((line) => (
            <li key={line}>Ignored: {line}</li>
          ))}
        </ul>
      )}
    </div>
  )
}

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

  // Launch-link prefill: read once on first render (a URL edited after
  // mount doesn't re-seed state out from under the artist's own edits).
  const searchParams = useSearchParams()
  const [launchLink] = useState(() => parseLaunchLink(searchParams))
  const [bannerDismissed, setBannerDismissed] = useState(false)
  const hasPrefill = Object.keys(launchLink.state).length > 0

  const [state, setState] = useState<WizardState>(() => ({
    ...initialWizardState,
    ...launchLink.state,
  }))
  const [step, setStep] = useState<StepId>(() => (launchLink.state.preset ? "config" : "preset"))
  const [uploadResult, setUploadResult] = useState<{
    name: string
    codeHash: `0x${string}`
  } | null>(null)

  const price = useEthAmountInput({ initialWei: launchLinkPriceWei(launchLink.state.priceRaw) })

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

  const showBanner = (hasPrefill || launchLink.ignored.length > 0) && !bannerDismissed
  const banner = showBanner && (
    <LaunchLinkBanner
      ignored={launchLink.ignored}
      dismissed={bannerDismissed}
      onDismiss={() => setBannerDismissed(true)}
    />
  )

  if (!address) {
    return (
      <div className="space-y-4">
        {banner}
        <Shell>
          <ConnectButton.Custom>
            {({ openConnectModal }) => (
              <button onClick={openConnectModal} className={BTN}>
                Connect wallet to start
              </button>
            )}
          </ConnectButton.Custom>
        </Shell>
      </div>
    )
  }

  if (wrongNetwork) {
    return (
      <div className="space-y-4">
        {banner}
        <Shell>
          <button
            onClick={() => switchChain({ chainId: PREFERRED_CHAIN.id })}
            disabled={isSwitchPending}
            className={BTN}
          >
            {isSwitchPending ? "Switching…" : `Switch to ${PREFERRED_CHAIN_LABEL}`}
          </button>
        </Shell>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      {banner}
      {step !== "preset" && <Stepper steps={steps} current={step} />}

      <div className="rounded-lg border border-gray-200 bg-surface p-5">
        {step === "preset" && (
          <PresetStep
            editionAvailable={factoryStatus.defaultRendererSet}
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
        Deploy an onchain contract configured with your artwork and mint conditions.
      </p>
      {children}
    </div>
  )
}
