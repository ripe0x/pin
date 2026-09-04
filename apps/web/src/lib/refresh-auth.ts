/** Shared, human-readable wallet proofs for refresh queues. */
export const REFRESH_NONCE_MAX_AGE_S = 5 * 60

export function buildArtistRefreshMessage(artist: string, nonce: number): string {
  return [
    "PND artist refresh v1",
    `artist=${artist.toLowerCase()}`,
    `nonce=${nonce}`,
  ].join("\n")
}

export function buildTokenRefreshMessage(
  signer: string,
  contract: string,
  tokenId: string,
  nonce: number,
): string {
  return [
    "PND token metadata refresh v1",
    `signer=${signer.toLowerCase()}`,
    `contract=${contract.toLowerCase()}`,
    `tokenId=${tokenId}`,
    `nonce=${nonce}`,
  ].join("\n")
}

export function isFreshRefreshNonce(nonce: number, nowSeconds: number): boolean {
  if (!Number.isInteger(nonce)) return false
  const age = nowSeconds - nonce
  return age >= -60 && age <= REFRESH_NONCE_MAX_AGE_S
}
