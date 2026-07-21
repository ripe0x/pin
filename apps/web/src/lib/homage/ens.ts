// Client-side ENS resolution for the homage allowlist checker. Calls /api/homage/ens, which
// offloads to a hosted service (ensideas, with an ensdata fallback), so the browser makes no
// RPC call. Results
// are memoized per session, so repeat lookups of the same input never refetch.

export type EnsResolution = {address: string | null; name: string | null; displayName: string | null}

const memo = new Map<string, Promise<EnsResolution>>()

/** Resolve an ENS name (or reverse-resolve an address for display). Throws only if the resolver
 *  service is unreachable; an input that simply doesn't resolve returns `{address: null, …}`. */
export function resolveEns(query: string): Promise<EnsResolution> {
  const key = query.trim().toLowerCase()
  let pending = memo.get(key)
  if (!pending) {
    pending = fetch(`/api/homage/ens?q=${encodeURIComponent(query.trim())}`)
      .then(async (r) => {
        if (!r.ok) throw new Error("ENS resolver unavailable")
        return (await r.json()) as EnsResolution
      })
      .catch((e) => {
        memo.delete(key) // a transient failure should retry next time, not stick
        throw e
      })
    memo.set(key, pending)
  }
  return pending
}
