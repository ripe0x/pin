// Pure age-to-status mapping, split out of indexer-health.ts (which has
// `import "server-only"` and can't be loaded by the plain-Node test
// runner) so this logic is unit testable without a database.

/** Age past which the indexed schema is considered stale (route 503s, studio shows a banner). */
export const STALE_THRESHOLD_SEC = 60 * 60

export function isFreshnessStale(ageSeconds: number): boolean {
  return ageSeconds > STALE_THRESHOLD_SEC
}

/** HTTP status for `/api/health/indexer`: 503 for both "stale" and "unknown". */
export function freshnessHttpStatus(ageSeconds: number | null): 200 | 503 {
  if (ageSeconds === null) return 503
  return isFreshnessStale(ageSeconds) ? 503 : 200
}
