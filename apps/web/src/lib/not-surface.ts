/**
 * Shared "this address isn't a PND Surface collection" handling for the
 * studio tools that configure a collection's canonical minter (mint gate,
 * sale settings). Their APIs (/api/collections/[address]/allowlist without
 * a wallet, /api/collections/[address]/sale) answer a non-member address
 * with 404 `{ notSurface: true }`, checked against the indexed Surface set
 * with the factory `isSurface` read as fallback (isFactoryCollection).
 * Pure, so the response classification is unit tested.
 */

export const NOT_SURFACE_MINT_GATE_MESSAGE =
  "This address isn't a PND Surface collection. The mint gate configures allowlists and wallet limits on collections launched through PND."

export const NOT_SURFACE_SALE_MESSAGE =
  "This address isn't a PND Surface collection. Sale settings edit price, mint window and payout on collections launched through PND."

/** Body the collection APIs send for a non-member address. */
export const NOT_SURFACE_BODY = { error: "Not a Surface collection.", notSurface: true } as const

/** True when a collection API response says the address is not a Surface. */
export function isNotSurfaceResponse(status: number, body: unknown): boolean {
  return (
    status === 404 &&
    typeof body === "object" &&
    body !== null &&
    (body as { notSurface?: unknown }).notSurface === true
  )
}
