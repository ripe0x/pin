/**
 * SHA-256 of arbitrary bytes, as a `0x`-prefixed lowercase hex string.
 *
 * This is the exact integrity hash MURI expects for an artwork's `fileHash`:
 * MURI's default on-chain HTML viewer fetches each fallback URI, runs
 * SHA-256 over the bytes, and renders the first copy whose hash matches
 * (`expectedHash.replace('0x','')`). Producing the hash the same way here
 * means a freshly uploaded file verifies on-chain.
 *
 * Uses the Web Crypto API (`crypto.subtle`), available in browsers and in
 * Node 18+ — no extra dependency.
 */
export async function sha256Hex(bytes: ArrayBuffer | Uint8Array): Promise<string> {
  // Cast to BufferSource: a Uint8Array's generic buffer type (ArrayBufferLike)
  // can include SharedArrayBuffer, which the DOM lib's digest signature
  // rejects; the runtime accepts any ArrayBufferView regardless.
  const buf = (bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)) as BufferSource
  const digest = await crypto.subtle.digest("SHA-256", buf)
  const hex = Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
  return `0x${hex}`
}

/** Convenience: SHA-256 of a File/Blob's contents (browser upload path). */
export async function sha256HexOfBlob(blob: Blob): Promise<string> {
  return sha256Hex(await blob.arrayBuffer())
}
