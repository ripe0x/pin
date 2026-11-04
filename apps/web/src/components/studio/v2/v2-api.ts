/**
 * Client fetch for GET /api/collections/[address]/v2: the live state the
 * studio's primitive v2 panels read, or the routing answer that keeps a v1
 * (or superseded August v2) collection on the existing tools.
 */

import { isNotSurfaceResponse } from "../../../lib/not-surface.ts"
import type { NotV2State, SurfaceV2State } from "../../../lib/surface-v2-studio.ts"

export type V2Lookup = SurfaceV2State | NotV2State | "not-surface" | null

/** The collection's v2 state; `{ primitiveV2: false }` for a v1 Surface,
 *  "not-surface" outside the Surface set, null on any read failure. */
export async function fetchSurfaceV2(collection: string): Promise<V2Lookup> {
  try {
    const res = await fetch(`/api/collections/${collection.toLowerCase()}/v2`, { cache: "no-store" })
    const body = (await res.json().catch(() => null)) as unknown
    if (isNotSurfaceResponse(res.status, body)) return "not-surface"
    if (!res.ok || !body || typeof body !== "object") return null
    return body as SurfaceV2State | NotV2State
  } catch {
    return null
  }
}
