import { isAddress, type Address } from "viem"

/**
 * Parses `{ owner: address }` from a decoded JSON request body. Pure so it
 * can be unit tested without constructing a Next.js `Request`.
 */
export function parseOwnerBody(
  body: unknown,
): { owner: Address } | { error: string } {
  const owner = (body as { owner?: unknown } | null)?.owner
  if (typeof owner !== "string" || !isAddress(owner)) {
    return { error: "owner must be a 0x address" }
  }
  return { owner }
}
