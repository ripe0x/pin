/**
 * State shape for the create-collection wizard. Kept dependency-free (no
 * form library, per AGENTS.md/repo convention) — a plain object updated via
 * a single setState in CreateCollectionWizard, passed down as props.
 */

import type { Preset } from "@/lib/create-collection"

export type CollabRow = { address: string }

export type WizardState = {
  preset: Preset | null

  // Shared fields (Edition + Generative)
  name: string
  symbol: string
  artworkURI: string // required for Edition, optional cover for Generative
  priceRaw: string // raw ETH input string; parsed via useEthAmountInput at the form layer
  openSupply: boolean
  supplyCap: string
  hasWindow: boolean
  startAt: string
  endAt: string
  royaltyPct: string
  payout: string
  collaborators: CollabRow[]

  // Generative-only
  script: string
  scriptFileName: string | null
  selectedDeps: string[] // KNOWN_DEPENDENCIES ids
  liveness: 0 | 1 | 2
  renderParams: string

  // Renderer-native-only
  customRenderer: string

  // Upload progress (Generative only) — chunk index is the resume point.
  contentNameChosen: string | null
  chunksUploaded: number
  totalChunks: number

  // Deploy result
  deployedAddress: string | null
}

export const initialWizardState: WizardState = {
  preset: null,
  name: "",
  symbol: "",
  artworkURI: "",
  priceRaw: "",
  openSupply: true,
  supplyCap: "100",
  hasWindow: false,
  startAt: "",
  endAt: "",
  royaltyPct: "10",
  payout: "",
  collaborators: [],
  script: "",
  scriptFileName: null,
  selectedDeps: [],
  liveness: 0,
  renderParams: "",
  customRenderer: "",
  contentNameChosen: null,
  chunksUploaded: 0,
  totalChunks: 0,
  deployedAddress: null,
}

/** Step graph. Renderer-native and Edition skip script/preview/upload. */
export type StepId =
  | "preset"
  | "config"
  | "preview"
  | "upload"
  | "deploy"

export function stepsForPreset(preset: Preset | null): StepId[] {
  if (preset === "generative") {
    return ["preset", "config", "preview", "upload", "deploy"]
  }
  // edition + renderer-native: no code, so no preview/upload steps.
  return ["preset", "config", "deploy"]
}
