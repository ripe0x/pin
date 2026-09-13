/**
 * Launch-link prefill for the studio create-collection wizard. A curated
 * launch link seeds the wizard's initial state from URL search params so an
 * artist opens one link with name, price, supply, and so on already filled
 * in; every field stays editable, nothing here writes to the chain.
 *
 * Pure functions only (no DOM/React), so both directions, parse a link
 * into wizard state, build a link from wizard state, are unit testable
 * without a browser. See create-collection-launch-link.test.ts.
 */

import { isAddress } from "viem"
import type { Preset } from "./create-collection"
import type { CollabRow, WizardState } from "@/components/studio/create/types"
// .ts extension: import-type erasure aside, this is a real runtime import,
// and Node's --experimental-strip-types (the test runner for this file)
// needs an explicit extension on relative specifiers.
import { parseEthAmount } from "./parseEthAmount.ts"

/** Minimal shape both URLSearchParams and Next's ReadonlyURLSearchParams satisfy. */
export type SearchParamsLike = { get(key: string): string | null }

export type LaunchLinkResult = {
  state: Partial<WizardState>
  /** One entry per ignored param, naming the param and why. */
  ignored: string[]
}

/** "YYYY-MM-DDTHH:mm" in local time, the value a datetime-local input needs. */
function isoToDatetimeLocal(iso: string): string | null {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return null
  const pad = (n: number) => String(n).padStart(2, "0")
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** Inverse of isoToDatetimeLocal: a datetime-local value back to ISO 8601. */
function datetimeLocalToIso(value: string): string | null {
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return null
  return d.toISOString()
}

/**
 * Parses a launch link's search params into partial wizard state. Every
 * value is checked against the same rules the wizard form itself enforces;
 * an invalid value is dropped and named in `ignored` rather than failing
 * the whole link. `generative` is a valid preset in the wizard's data model
 * but disabled in its UI, so a launch link naming it is treated the same as
 * an unknown preset.
 */
export function parseLaunchLink(params: SearchParamsLike): LaunchLinkResult {
  const state: Partial<WizardState> = {}
  const ignored: string[] = []

  const preset = params.get("preset")
  if (preset === "edition" || preset === "renderer") {
    state.preset = preset satisfies Preset
  } else if (preset === "generative") {
    ignored.push("preset: generative collections aren't available from a launch link")
  } else if (preset !== null) {
    ignored.push(`preset: "${preset}" is not a known preset`)
  }

  const name = params.get("name")
  if (name !== null && name.trim()) state.name = name.trim()

  const symbol = params.get("symbol")
  if (symbol !== null && symbol.trim()) state.symbol = symbol.trim().toUpperCase()

  const price = params.get("price")
  if (price !== null) {
    const parsed = parseEthAmount(price)
    if (parsed.ok) state.priceRaw = parsed.canonical
    else ignored.push(`price: ${parsed.reason}`)
  }

  const supplyCap = params.get("supplyCap")
  if (supplyCap !== null) {
    const n = Number(supplyCap)
    if (Number.isInteger(n) && n > 0) {
      state.supplyCap = String(n)
      state.openSupply = false
    } else {
      ignored.push(`supplyCap: "${supplyCap}" is not a positive whole number`)
    }
  }

  const openSupply = params.get("openSupply")
  if (openSupply !== null) {
    if (openSupply === "1") state.openSupply = true
    else ignored.push(`openSupply: "${openSupply}" is not "1"`)
  }

  const royaltyPct = params.get("royaltyPct")
  if (royaltyPct !== null) {
    const n = Number(royaltyPct)
    if (Number.isFinite(n) && n >= 0 && n <= 50) {
      state.royaltyPct = royaltyPct.trim()
    } else {
      ignored.push(`royaltyPct: "${royaltyPct}" must be between 0 and 50`)
    }
  }

  const payout = params.get("payout")
  if (payout !== null) {
    if (isAddress(payout)) state.payout = payout
    else ignored.push(`payout: "${payout}" is not a valid address`)
  }

  const renderer = params.get("renderer")
  if (renderer !== null) {
    if (isAddress(renderer)) {
      state.customRenderer = renderer
      if (state.preset === undefined) state.preset = "renderer"
    } else {
      ignored.push(`renderer: "${renderer}" is not a valid address`)
    }
  }

  const startAt = params.get("startAt")
  const endAt = params.get("endAt")
  const startLocal = startAt !== null ? isoToDatetimeLocal(startAt) : null
  const endLocal = endAt !== null ? isoToDatetimeLocal(endAt) : null
  if (startAt !== null && startLocal === null) ignored.push(`startAt: "${startAt}" is not a valid date`)
  if (endAt !== null && endLocal === null) ignored.push(`endAt: "${endAt}" is not a valid date`)
  if (startLocal !== null && endLocal !== null && new Date(startAt as string) >= new Date(endAt as string)) {
    ignored.push("startAt/endAt: the window must open before it closes")
  } else {
    if (startLocal !== null) {
      state.hasWindow = true
      state.startAt = startLocal
    }
    if (endLocal !== null) {
      state.hasWindow = true
      state.endAt = endLocal
    }
  }

  const collaborators = params.get("collaborators")
  if (collaborators !== null) {
    const rows: CollabRow[] = []
    const seen = new Set<string>()
    let dropped = false
    for (const raw of collaborators.split(",").map((s) => s.trim()).filter(Boolean)) {
      const lower = raw.toLowerCase()
      if (!isAddress(raw) || seen.has(lower)) {
        dropped = true
        continue
      }
      seen.add(lower)
      rows.push({ address: raw })
    }
    if (rows.length > 0) state.collaborators = rows
    if (dropped) ignored.push("collaborators: one or more addresses were invalid or duplicates and were dropped")
  }

  return { state, ignored }
}

/**
 * Inverse of parseLaunchLink: builds a launch-link query string (no leading
 * "?") from wizard state. Only fields with a meaningful value are included,
 * so re-parsing the output reproduces the same prefill.
 */
export function buildLaunchLink(state: Partial<WizardState>): string {
  const params = new URLSearchParams()

  if (state.preset === "edition" || state.preset === "renderer") params.set("preset", state.preset)
  if (state.name?.trim()) params.set("name", state.name.trim())
  if (state.symbol?.trim()) params.set("symbol", state.symbol.trim())
  if (state.priceRaw?.trim()) params.set("price", state.priceRaw.trim())
  if (state.openSupply === false && state.supplyCap?.trim()) params.set("supplyCap", state.supplyCap.trim())
  if (state.openSupply === true) params.set("openSupply", "1")
  if (state.royaltyPct?.trim()) params.set("royaltyPct", state.royaltyPct.trim())
  if (state.payout?.trim()) params.set("payout", state.payout.trim())
  if (state.customRenderer?.trim()) params.set("renderer", state.customRenderer.trim())
  if (state.hasWindow) {
    if (state.startAt) {
      const iso = datetimeLocalToIso(state.startAt)
      if (iso) params.set("startAt", iso)
    }
    if (state.endAt) {
      const iso = datetimeLocalToIso(state.endAt)
      if (iso) params.set("endAt", iso)
    }
  }
  if (state.collaborators && state.collaborators.length > 0) {
    const addrs = state.collaborators.map((c) => c.address.trim()).filter(Boolean)
    if (addrs.length > 0) params.set("collaborators", addrs.join(","))
  }

  return params.toString()
}
