"use client"

/** Step 2: identity and the collaborator roster. */

import type { WizardState } from "./types"
import { IdentityFields, CollaboratorFields, validateCollaborators } from "./SharedFields"
import { ERROR, BTN, BTN_SECONDARY } from "./wizard-ui"

type Setter = <K extends keyof WizardState>(key: K, value: WizardState[K]) => void

export function DetailsStep({
  state,
  set,
  onBack,
  onNext,
}: {
  state: WizardState
  set: Setter
  onBack: () => void
  onNext: () => void
}) {
  const identityOk = state.name.trim().length > 0 && state.symbol.trim().length > 0
  const collabCheck = validateCollaborators(state.collaborators)
  const canProceed = identityOk && collabCheck.ok

  return (
    <div className="space-y-5">
      <header className="space-y-1.5">
        <h3 className="text-sm font-medium">Details</h3>
      </header>

      <IdentityFields state={state} set={set} disabled={false} />
      <CollaboratorFields state={state} set={set} disabled={false} />

      {!identityOk && <p className={ERROR}>Name and symbol are required.</p>}

      <div className="flex gap-3">
        <button onClick={onBack} className={BTN_SECONDARY}>
          Back
        </button>
        <button onClick={onNext} disabled={!canProceed} className={BTN}>
          Continue
        </button>
      </div>
    </div>
  )
}
