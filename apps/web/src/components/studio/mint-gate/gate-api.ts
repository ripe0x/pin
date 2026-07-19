/**
 * Client-side fetch helpers for the mint gate studio tool. Both hit the
 * same /api/collections/[address]/allowlist route the public mint page's
 * MintGate.tsx uses (see lib/allowlist.ts for the trust model: publishing
 * is permissionless, only the root a collection's owner/admin sets onchain
 * via FixedPriceMinter.setAllowlistRoot grants anything). No direct chain
 * reads here — the API's GET already wraps a config-class-cached
 * getMinterGate.
 */

export const ZERO_ROOT = ("0x" + "0".repeat(64)) as `0x${string}`

/** Mirrors the two response shapes of GET /api/collections/[address]/allowlist
 *  (no ?wallet param — the gate-summary branch). `minter` is present
 *  whenever a canonical minter is on record (both branches), since
 *  ActivationQueue writes directly to it. */
export type GateApiState =
  | { gated: false; minter: `0x${string}` | null; knownMinter: boolean; cap: string }
  | { gated: true; minter: `0x${string}`; root: `0x${string}`; cap: string; count: number | null }

/** Normalized view of a collection's gate, regardless of which API branch
 *  answered. `root` is the zero root whenever the collection has no
 *  canonical minter, or its minter's allowlist is unset (matching the API's
 *  own "gated" definition: a canonical minter AND a nonzero root). */
export type DerivedGate = {
  /** A canonical FixedPriceMinter is wired for this collection (allowlist +
   *  wallet-cap config is readable/settable on it directly — there is no
   *  separate hook to attach anymore). */
  hasMinter: boolean
  minter: `0x${string}` | null
  root: `0x${string}`
  cap: string
  /** Published list size for the active root; null when there's no active
   *  root to look one up for. */
  count: number | null
}

export function deriveGate(state: GateApiState | null): DerivedGate | null {
  if (!state) return null
  if (state.gated) {
    return {
      hasMinter: true,
      minter: state.minter,
      root: state.root,
      cap: state.cap,
      count: state.count,
    }
  }
  return {
    hasMinter: state.knownMinter,
    minter: state.minter,
    root: ZERO_ROOT,
    cap: state.cap,
    count: null,
  }
}

export async function fetchGateState(collection: string): Promise<GateApiState | null> {
  try {
    const res = await fetch(`/api/collections/${collection.toLowerCase()}/allowlist`, {
      cache: "no-store",
    })
    if (!res.ok) return null
    return (await res.json()) as GateApiState
  } catch {
    return null
  }
}

export type PublishResult =
  | { ok: true; root: `0x${string}`; count: number }
  | { ok: false; error: string }

export async function publishList(collection: string, addresses: string[]): Promise<PublishResult> {
  try {
    const res = await fetch(`/api/collections/${collection.toLowerCase()}/allowlist`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ addresses }),
    })
    const body = (await res.json()) as { root?: `0x${string}`; count?: number; error?: string }
    if (!res.ok || body.error || !body.root) {
      return { ok: false, error: body.error ?? "Publish failed." }
    }
    return { ok: true, root: body.root, count: body.count ?? addresses.length }
  } catch {
    return { ok: false, error: "Publish failed. Try again." }
  }
}
