/**
 * Tell a contract's real "no" apart from an RPC failure (audit L4).
 *
 * warm-contract-identity used to write `.catch(() => false)` results
 * straight into contract_identity, which is never refreshed: one timeout
 * while probing supportsInterface permanently recorded a real ERC-721 as
 * "not ERC-721". viem surfaces the two cases differently:
 *
 *   - negative: the call reached the contract and it reverted
 *     (ContractFunctionRevertedError: no ERC-165, no name()), or
 *     returned no data (ContractFunctionZeroDataError: the function or
 *     the code isn't there). That IS the answer; cache it.
 *   - transient: anything else (HTTP / timeout / rate limit / RPC
 *     internal error). Not an answer; don't cache, retry later.
 *
 * Pure module, unit-tested.
 */
import {
  BaseError,
  ContractFunctionRevertedError,
  ContractFunctionZeroDataError,
} from "viem"

export type ReadErrorKind = "negative" | "transient"

export function classifyReadError(err: unknown): ReadErrorKind {
  if (err instanceof BaseError) {
    const hit = err.walk(
      (e) => e instanceof ContractFunctionRevertedError || e instanceof ContractFunctionZeroDataError,
    )
    if (hit) return "negative"
  }
  return "transient"
}

export type Settled<T> = { ok: true; value: T } | { ok: false; error: unknown }

/**
 * Await a contract read; a negative answer becomes `negativeValue`, a
 * transient failure comes back as `{ ok: false }`.
 */
export async function settleRead<T>(p: Promise<T>, negativeValue: T): Promise<Settled<T>> {
  try {
    return { ok: true, value: await p }
  } catch (error) {
    return classifyReadError(error) === "negative"
      ? { ok: true, value: negativeValue }
      : { ok: false, error }
  }
}
