/**
 * Client-side fetch helper for the Admins studio tool. Hits
 * /api/collections/[address]/admins, which wraps a cached
 * getCollectionAuthority read (owner, live admin set, renderer-lock state).
 * No direct chain reads here.
 */

export type AuthorityState = {
  owner: `0x${string}`
  admins: `0x${string}`[]
  rendererLocked: boolean
}

export async function fetchAuthorityState(collection: string): Promise<AuthorityState | null> {
  try {
    const res = await fetch(`/api/collections/${collection.toLowerCase()}/admins`, {
      cache: "no-store",
    })
    if (!res.ok) return null
    return (await res.json()) as AuthorityState
  } catch {
    return null
  }
}
