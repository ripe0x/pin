/**
 * Sovereign storage substrate for PND Editions artwork.
 *
 * The substrate is identical across backends: drop a file, hash it, upload it
 * from the artist's own wallet (or BYO key), set `artworkURI`, show honest
 * status. PND never custodies, pins, or pays for the bytes. Each backend
 * (Arweave via Irys, IPFS via the artist's Pinata key) returns this same
 * shape so the UI can treat them uniformly.
 */

/** Which sovereign storage backend produced (or holds) the artwork bytes. */
export type StorageBackend = "arweave" | "ipfs"

export type StorageUploadResult = {
  backend: StorageBackend
  /**
   * Scheme URI to persist as the edition's `artworkURI` (`ar://<id>` or
   * `ipfs://<cid>`). Content-addressed and gateway-agnostic, so any
   * Arweave/IPFS-aware client resolves it.
   */
  uri: string
  /**
   * An https URL that resolves the same bytes immediately, for preview and
   * retrievability checks. (For Arweave this is the Irys gateway, which
   * serves optimistically; arweave.net can lag until the bundle finalizes.)
   */
  gatewayUrl: string
  /** Number of bytes uploaded. */
  bytes: number
}
