/**
 * Content-addressed object key for a derivative: `<prefix>/<hash[0:2]>/<hash>.<ext>`.
 * The two-character shard keeps a single directory from holding every
 * derivative a store ever produces.
 */
export function derivativeKey(prefix: string, sha256: string, extension: string): string {
  const ext = extension.replace(/[^a-z0-9]/gi, "").toLowerCase()
  if (!/^[0-9a-f]{64}$/.test(sha256) || !ext) {
    throw new Error("invalid derivative object identity")
  }
  const cleanPrefix = prefix.replace(/^\/+|\/+$/g, "")
  return `${cleanPrefix}/${sha256.slice(0, 2)}/${sha256}.${ext}`
}
