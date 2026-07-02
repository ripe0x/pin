/**
 * Client-side provider registries for the generic mint surface: quote
 * providers (dynamic pricing), eligibility providers (per-phase gating), and
 * args builders (per-phase calldata). Descriptors reference implementations
 * by string key; implementations register here at module scope, next to the
 * collection that owns them.
 *
 * Why string keys instead of function references on the descriptor:
 * `mint-collections.ts` is client-safe data consumed by both server reads and
 * client components. Providers, by contrast, are client-runtime code (they
 * take a viem PublicClient from wagmi and may hold heavy deps — quoter ABIs,
 * merkle proofs). Keying keeps the descriptor serializable and keeps provider
 * code out of every consumer of the registry.
 *
 * Registration pattern for a new collection (e.g. the Homage modules): create
 * `src/lib/mint-modules/<slug>.ts` that calls the register* functions at
 * module scope, and import it for side effects from `mint-collections.ts`
 * (which every mint surface already loads) so registrations are guaranteed to
 * run before any lookup:
 *
 *   // mint-modules/homage.ts
 *   registerQuoteProvider("homage-quote", async ({ client, wallet }) => …)
 *   registerEligibilityProvider("homage-claim", async ({ client, wallet }) => …)
 *   registerArgsBuilder("homage-claim", ({ selection }) => [selection as bigint])
 *
 *   // mint-collections.ts
 *   import "./mint-modules/homage"
 *
 * RPC discipline note: providers run client-side against the wagmi public
 * client. The HOOKS that invoke them (mint-hooks.ts) own the refresh policy —
 * mount + visibility-gated interval + manual refresh, never per-render.
 * Providers themselves should be single-shot (no internal polling).
 */

import type { Address, PublicClient } from "viem"

// ── quote providers (2.2) ───────────────────────────────────────────────────

/** A resolved quote: the exact msg.value plus a display breakdown. */
export type MintQuote = {
  /** Exact wei to send with the mint. */
  value: bigint
  /** Display lines summing (conceptually) to `value`, e.g. swap / fee / margin. */
  breakdown: { label: string; wei: bigint }[]
  /** Optional footnote, e.g. "excess $111/ETH refunded". */
  note?: string
  /** How long this quote stays fresh; drives the visibility-gated refresh. */
  ttlMs: number
}

export type QuoteProviderCtx = {
  client: PublicClient
  wallet?: Address
  /** Active phase key, or null for non-phased collections. */
  phaseKey: string | null
}

/**
 * Throwing signals "no quote available" (quoter revert, thin pool); the mint
 * button disables with the thrown message as the reason.
 */
export type QuoteProvider = (ctx: QuoteProviderCtx) => Promise<MintQuote>

const quoteProviders = new Map<string, QuoteProvider>()

export function registerQuoteProvider(key: string, provider: QuoteProvider): void {
  quoteProviders.set(key, provider)
}

export function getQuoteProvider(key: string): QuoteProvider | undefined {
  return quoteProviders.get(key)
}

// ── eligibility providers (2.3) ─────────────────────────────────────────────

export type EligibilityResult = {
  eligible: boolean
  /** Shown when ineligible ("no unclaimed punks in this wallet") — and also
   *  usable as positive context when eligible ("on allowlist, 2 of 3 left"). */
  reason?: string
  /** Provider-private payload handed to the args builder (e.g. the owned
   *  punk ids, or a merkle proof) and to the phase-selector component. */
  data?: unknown
}

export type EligibilityCtx = {
  client: PublicClient
  wallet?: Address
  /** Active phase key, or null for non-phased collections (Vouch). */
  phaseKey: string | null
}

export type EligibilityProvider = (ctx: EligibilityCtx) => Promise<EligibilityResult>

const eligibilityProviders = new Map<string, EligibilityProvider>()

export function registerEligibilityProvider(key: string, provider: EligibilityProvider): void {
  eligibilityProviders.set(key, provider)
}

export function getEligibilityProvider(key: string): EligibilityProvider | undefined {
  return eligibilityProviders.get(key)
}

// ── args builders (2.3) ─────────────────────────────────────────────────────

export type ArgsBuilderCtx = EligibilityCtx & {
  /** What the user picked in the phase's selector component, if any. */
  selection?: unknown
  /** The `data` payload from this phase's eligibility provider, if any. */
  eligibilityData?: unknown
}

/**
 * Builds the mint call's args at click time. May be async (e.g. lazy-load a
 * proof artifact); throwing aborts the write and surfaces the message.
 */
export type ArgsBuilder = (ctx: ArgsBuilderCtx) => unknown[] | Promise<unknown[]>

const argsBuilders = new Map<string, ArgsBuilder>()

export function registerArgsBuilder(key: string, builder: ArgsBuilder): void {
  argsBuilders.set(key, builder)
}

export function getArgsBuilder(key: string): ArgsBuilder | undefined {
  return argsBuilders.get(key)
}
