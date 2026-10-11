/**
 * State shape for the create-collection wizard. Kept dependency-free (no
 * form library, per AGENTS.md/repo convention) — a plain object updated via
 * a single setState in CreateCollectionWizard, passed down as props.
 *
 * The wizard has one fixed step graph: an artist who already deployed a
 * renderer contract points a new collection at it, sets its identity and
 * sale terms, then deploys. No presets.
 */

export type CollabRow = { address: string }

export type WizardState = {
  // Step 1: renderer
  rendererAddress: string

  // Step 2: details
  name: string
  symbol: string
  collaborators: CollabRow[]

  // Step 3: sale
  priceRaw: string // raw ETH input string; parsed via useEthAmountInput at the form layer
  openSupply: boolean
  supplyCap: string
  hasWindow: boolean
  startAt: string
  endAt: string
  royaltyPct: string
  payout: string
  artworkURI: string // optional cover image URI

  // Deploy result
  deployedAddress: string | null
}

export const initialWizardState: WizardState = {
  rendererAddress: "",
  name: "",
  symbol: "",
  collaborators: [],
  priceRaw: "",
  openSupply: true,
  supplyCap: "100",
  hasWindow: false,
  startAt: "",
  endAt: "",
  royaltyPct: "10",
  payout: "",
  artworkURI: "",
  deployedAddress: null,
}

export type StepId = "renderer" | "details" | "sale" | "deploy"

export const WIZARD_STEPS: StepId[] = ["renderer", "details", "sale", "deploy"]
