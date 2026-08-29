/** Shared, human-readable wallet proof for the artist refresh queue. */
export const REFRESH_NONCE_MAX_AGE_S = 5 * 60

export function buildArtistRefreshMessage(artist: string, nonce: number): string {
  return [
    "PND artist refresh v1",
    `artist=${artist.toLowerCase()}`,
    `nonce=${nonce}`,
  ].join("\n")
}

export function isFreshRefreshNonce(nonce: number, nowSeconds: number): boolean {
  if (!Number.isInteger(nonce)) return false
  const age = nowSeconds - nonce
  return age >= -60 && age <= REFRESH_NONCE_MAX_AGE_S
}
