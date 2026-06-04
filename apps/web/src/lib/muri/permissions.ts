/**
 * MURI permission bit flags (mirrors the constants in MURIProtocol.sol).
 * Artist bits occupy 0-6, collector bits 7-10. Packed into a single uint16
 * on the token's `Permissions.flags`.
 */
export const MURI_PERM = {
  ARTIST_UPDATE_THUMB: 1 << 0,
  ARTIST_UPDATE_META: 1 << 1,
  ARTIST_CHOOSE_URIS: 1 << 2,
  ARTIST_ADD_REMOVE: 1 << 3,
  ARTIST_CHOOSE_THUMB: 1 << 4,
  ARTIST_UPDATE_MODE: 1 << 5,
  ARTIST_UPDATE_TEMPLATE: 1 << 6,
  COLLECTOR_CHOOSE_URIS: 1 << 7,
  COLLECTOR_ADD_REMOVE: 1 << 8,
  COLLECTOR_CHOOSE_THUMB: 1 << 9,
  COLLECTOR_UPDATE_MODE: 1 << 10,
} as const

/** All seven artist bits set (full artist control). */
export const ARTIST_ALL =
  MURI_PERM.ARTIST_UPDATE_THUMB |
  MURI_PERM.ARTIST_UPDATE_META |
  MURI_PERM.ARTIST_CHOOSE_URIS |
  MURI_PERM.ARTIST_ADD_REMOVE |
  MURI_PERM.ARTIST_CHOOSE_THUMB |
  MURI_PERM.ARTIST_UPDATE_MODE |
  MURI_PERM.ARTIST_UPDATE_TEMPLATE

/**
 * Build the packed permission flags for a fresh mint.
 *
 * Default: full artist control. `allowCollectorFallbacks` (default on, the
 * collaborative-preservation spirit of MURI) lets the current token owner
 * add their own fallback URIs and choose the active one in HTML mode.
 */
export function buildPermissionFlags(opts?: {
  allowCollectorFallbacks?: boolean
}): number {
  const allowCollector = opts?.allowCollectorFallbacks ?? true
  let flags = ARTIST_ALL
  if (allowCollector) {
    flags |= MURI_PERM.COLLECTOR_ADD_REMOVE | MURI_PERM.COLLECTOR_CHOOSE_URIS
  }
  return flags
}
