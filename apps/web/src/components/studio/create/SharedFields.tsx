"use client"

/**
 * Config fields common to every preset: identity and the cover/artwork
 * URI. Price, supply, mint window, royalty, payout, and the collaborator
 * creators list (the owner's side of attribution, NOT a payout split) are
 * shared by Edition and Generative; each listed creator confirms by
 * claiming the collection in the Catalog. Renderer-native uses identity and
 * the artwork field but composes the rest separately in ConfigStep.
 */

import { isAddress } from "viem"
import type { UseEthAmountInputResult } from "@/lib/useEthAmountInput"
import { formatBps, REFERRAL_SHARE_BPS } from "@/lib/collection"
import { isValidArtworkURI } from "@/lib/create-collection"
import type { CollabRow, WizardState } from "./types"
import { LABEL, INPUT, HELP, ERROR } from "./wizard-ui"

type Setter = <K extends keyof WizardState>(key: K, value: WizardState[K]) => void

export function IdentityFields({
  state,
  set,
  disabled,
}: {
  state: WizardState
  set: Setter
  disabled: boolean
}) {
  return (
    <div className="grid grid-cols-3 gap-3">
      <div className="col-span-2">
        <label className={LABEL} htmlFor="cc-name">
          Name
        </label>
        <input
          id="cc-name"
          className={INPUT}
          value={state.name}
          onChange={(e) => set("name", e.target.value)}
          placeholder="Studies in Grey"
          disabled={disabled}
        />
      </div>
      <div>
        <label className={LABEL} htmlFor="cc-symbol">
          Symbol
        </label>
        <input
          id="cc-symbol"
          className={INPUT}
          value={state.symbol}
          onChange={(e) => set("symbol", e.target.value.toUpperCase())}
          placeholder="GREY"
          disabled={disabled}
        />
      </div>
    </div>
  )
}

/** Cover/artwork URI, shown for every preset. `required` reflects whether
 *  the active preset's renderer reads its image from RenderAssets. */
export function ArtworkField({
  state,
  set,
  disabled,
  required,
}: {
  state: WizardState
  set: Setter
  disabled: boolean
  required: boolean
}) {
  const trimmed = state.artworkURI.trim()
  const invalid = trimmed !== "" && !isValidArtworkURI(trimmed)
  return (
    <div>
      <label className={LABEL} htmlFor="cc-cover">
        Cover image URI{required ? "" : " (optional)"}
      </label>
      <input
        id="cc-cover"
        className={INPUT}
        value={state.artworkURI}
        onChange={(e) => set("artworkURI", e.target.value.trim())}
        placeholder="ipfs://…"
        disabled={disabled}
      />
      <p className={HELP}>
        Cover image URI. Shown for every token until a capture or template is
        set. You host the file on IPFS or Arweave; PND never custodies media
        here.
      </p>
      {required && trimmed === "" && <p className={ERROR}>Cover image URI is required.</p>}
      {invalid && <p className={ERROR}>Must start with ipfs://, ar://, or https://</p>}
    </div>
  )
}

export function PriceSupplyWindowFields({
  state,
  set,
  price,
  disabled,
}: {
  state: WizardState
  set: Setter
  price: UseEthAmountInputResult
  disabled: boolean
}) {
  return (
    <>
      <div>
        <label className={LABEL} htmlFor="cc-price">
          Price (ETH)
        </label>
        <input
          id="cc-price"
          {...price.inputProps}
          placeholder="0"
          className={INPUT}
          disabled={disabled}
        />
        <p className={HELP}>
          0 = gas only (never called free). The artist always keeps at least{" "}
          {formatBps(10_000 - REFERRAL_SHARE_BPS)} of a paid mint; the fixed{" "}
          {formatBps(REFERRAL_SHARE_BPS)} referral share goes to PND when minted here, and
          you keep 100% by minting on your own site.
        </p>
        {price.error && <p className={ERROR}>{price.error}</p>}
      </div>

      <div>
        <label className="flex items-center gap-2 mb-2">
          <input
            type="checkbox"
            checked={state.openSupply}
            onChange={(e) => set("openSupply", e.target.checked)}
            disabled={disabled}
          />
          <span className="text-[11px] font-mono text-gray-600">Open supply (no cap)</span>
        </label>
        {!state.openSupply && (
          <input
            type="number"
            min={1}
            step={1}
            className={INPUT}
            value={state.supplyCap}
            onChange={(e) => set("supplyCap", e.target.value)}
            disabled={disabled}
            placeholder="Max supply"
          />
        )}
      </div>

      <div>
        <label className="flex items-center gap-2 mb-2">
          <input
            type="checkbox"
            checked={state.hasWindow}
            onChange={(e) => set("hasWindow", e.target.checked)}
            disabled={disabled}
          />
          <span className="text-[11px] font-mono text-gray-600">Set a mint window</span>
        </label>
        {state.hasWindow && (
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={LABEL} htmlFor="cc-start">
                Opens
              </label>
              <input
                id="cc-start"
                type="datetime-local"
                className={INPUT}
                value={state.startAt}
                onChange={(e) => set("startAt", e.target.value)}
                disabled={disabled}
              />
            </div>
            <div>
              <label className={LABEL} htmlFor="cc-end">
                Closes
              </label>
              <input
                id="cc-end"
                type="datetime-local"
                className={INPUT}
                value={state.endAt}
                onChange={(e) => set("endAt", e.target.value)}
                disabled={disabled}
              />
            </div>
          </div>
        )}
      </div>
    </>
  )
}

export function RoyaltyPayoutFields({
  state,
  set,
  disabled,
}: {
  state: WizardState
  set: Setter
  disabled: boolean
}) {
  const payoutOk = state.payout === "" || isAddress(state.payout)
  return (
    <div className="grid grid-cols-2 gap-3">
      <div>
        <label className={LABEL} htmlFor="cc-royalty">
          Royalty (%)
        </label>
        <input
          id="cc-royalty"
          type="text"
          inputMode="decimal"
          className={INPUT}
          value={state.royaltyPct}
          onChange={(e) => set("royaltyPct", e.target.value.replace(/[^0-9.]/g, ""))}
          disabled={disabled}
        />
        <p className={HELP}>EIP-2981, honored by marketplaces. Max 50%.</p>
      </div>
      <div>
        <label className={LABEL} htmlFor="cc-payout">
          Payout (optional)
        </label>
        <input
          id="cc-payout"
          className={INPUT}
          value={state.payout}
          onChange={(e) => set("payout", e.target.value.trim())}
          placeholder="defaults to you"
          disabled={disabled}
        />
        {!payoutOk && <p className={ERROR}>Invalid address</p>}
      </div>
    </div>
  )
}

/** Validates the collaborator roster: unique addresses, none required. */
export function validateCollaborators(rows: CollabRow[]): {
  ok: boolean
  error: string | null
  parsed: `0x${string}`[]
} {
  const filled = rows.filter((r) => r.address.trim() !== "")
  const parsed: `0x${string}`[] = []
  const seen = new Set<string>()
  for (const r of filled) {
    if (!isAddress(r.address)) return { ok: false, error: "Invalid collaborator address", parsed: [] }
    const lower = r.address.toLowerCase()
    if (seen.has(lower)) return { ok: false, error: "Duplicate collaborator address", parsed: [] }
    seen.add(lower)
    parsed.push(r.address as `0x${string}`)
  }
  return { ok: true, error: null, parsed }
}

export function CollaboratorFields({
  state,
  set,
  disabled,
}: {
  state: WizardState
  set: Setter
  disabled: boolean
}) {
  const check = validateCollaborators(state.collaborators)
  function setRow(i: number, value: string) {
    set(
      "collaborators",
      state.collaborators.map((r, j) => (j === i ? { address: value } : r)),
    )
  }
  return (
    <div>
      <label className={LABEL}>Collaborators (optional)</label>
      <div className="space-y-2">
        {state.collaborators.map((row, i) => (
          <div key={i} className="grid grid-cols-[1fr_28px] gap-2">
            <input
              className={INPUT}
              value={row.address}
              onChange={(e) => setRow(i, e.target.value.trim())}
              placeholder="0x… collaborator"
              disabled={disabled}
            />
            <button
              type="button"
              className="text-[11px] font-mono text-gray-400 hover:text-red-500 disabled:opacity-30"
              onClick={() =>
                set(
                  "collaborators",
                  state.collaborators.filter((_, j) => j !== i),
                )
              }
              disabled={disabled}
              aria-label="Remove collaborator"
            >
              ✕
            </button>
          </div>
        ))}
        <button
          type="button"
          className="text-[10px] font-mono uppercase tracking-wider text-gray-500 hover:text-fg disabled:opacity-30"
          onClick={() => set("collaborators", [...state.collaborators, { address: "" }])}
          disabled={disabled}
        >
          + Add collaborator
        </button>
        <p className={HELP}>
          Adds each address to this collection&rsquo;s onchain attribution roster.
          Each collaborator completes the handshake by claiming the collection in
          their own Catalog.
        </p>
        {check.error && <p className={ERROR}>{check.error}</p>}
      </div>
    </div>
  )
}
